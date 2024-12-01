const axios = require('axios');
const { exec } = require('child_process');
const { promisify } = require('util');
const fsPromises = require('fs').promises;
const fs = require('fs');
const path = require('path');
const execAsync = promisify(exec);

// Process command line arguments
const args = process.argv.slice(2);
const walletName = args[0];
const filePath = args[1];

if (!walletName || !filePath) {
  console.error('Usage: node mint.js <wallet-name> <file-path>');
  process.exit(1);
}

// Check if file exists synchronously before starting
if (!fs.existsSync(filePath)) {
  console.error(`Error: File ${filePath} does not exist`);
  process.exit(1);
}

// Configuration
const config = {
  monitorUrl: 'http://170.75.164.200:3000',
  checkInterval: 30000,
  mintCommandTemplate: `ord wallet --name {wallet} inscribe --file {file} --fee-rate 3 --postage "546 sats" --destination {destination}`,
  maxRetries: 3,
  retryDelay: 5000,
  minConfirmations: 1,
  logFile: 'minting-service.log',
  mintsFile: 'mints.json',
  walletName: walletName,
  filePath: filePath
};

// Tracking minting attempts and current operations
const mintingAttempts = new Map();
const activeOperations = new Set();

async function initMintsFile() {
  try {
    if (!fs.existsSync(config.mintsFile)) {
      await fsPromises.writeFile(config.mintsFile, JSON.stringify([], null, 2));
    }
  } catch (error) {
    console.error('Error initializing mints file:', error);
    process.exit(1);
  }
}

async function readMints() {
  try {
    const data = await fsPromises.readFile(config.mintsFile, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading mints file:', error);
    return [];
  }
}

async function saveMint(mintData) {
  try {
    const mints = await readMints();
    mints.push(mintData);
    await fsPromises.writeFile(config.mintsFile, JSON.stringify(mints, null, 2));
  } catch (error) {
    console.error('Error saving mint:', error);
  }
}

async function logToFile(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp} - ${message}\n`;
  console.log(message);
  
  try {
    await fsPromises.appendFile(config.logFile, logMessage);
  } catch (error) {
    console.error('Error writing to log file:', error);
  }
}

function parseInscriptionId(output) {
  try {
    const data = JSON.parse(output);
    if (data.inscriptions && data.inscriptions[0]) {
      return data.inscriptions[0].id;
    }
  } catch (error) {
    console.error('Error parsing inscription ID:', error);
  }
  return null;
}

async function executeMintCommand(senderAddress, txid) {
  try {
    if (!senderAddress) {
      throw new Error('No sender address provided for minting');
    }

    const logId = `${txid.substr(0, 8)}...${txid.substr(-8)}`;
    const mintCommand = config.mintCommandTemplate
      .replace('{wallet}', config.walletName)
      .replace('{file}', config.filePath)
      .replace('{destination}', senderAddress);
    
    await logToFile(`[${logId}] Executing mint command for ${senderAddress}`);
    await logToFile(`[${logId}] Command: ${mintCommand}`);
    
    const { stdout, stderr } = await execAsync(mintCommand);
    
    if (stdout) {
      await logToFile(`[${logId}] Mint output: ${stdout}`);
      
      const inscriptionId = parseInscriptionId(stdout);
      if (inscriptionId) {
        await saveMint({
          txid,
          inscriptionId,
          timestamp: new Date().toISOString(),
          destination: senderAddress
        });
        await logToFile(`[${logId}] Saved inscription ID: ${inscriptionId}`);
        return { success: true, inscriptionId };
      } else {
        await logToFile(`[${logId}] Warning: Could not parse inscription ID from output`);
      }
    }
    
    if (stderr) {
      await logToFile(`[${logId}] Mint stderr: ${stderr}`);
      if (stderr.includes('insufficient funds') || 
          stderr.includes('error') || 
          stderr.includes('failed')) {
        throw new Error(`Mint command failed: ${stderr}`);
      }
    }

    return { success: false };
  } catch (error) {
    await logToFile(`Error executing mint command: ${error.message}`);
    return { success: false };
  }
}

async function confirmMint(txid, inscriptionId) {
  try {
    await axios.post(`${config.monitorUrl}/api/confirm-mint`, { 
      txid,
      inscription_id: inscriptionId 
    });
    await logToFile(`Successfully confirmed mint for transaction ${txid}`);
    return true;
  } catch (error) {
    await logToFile(`Error confirming mint for transaction ${txid}: ${error.message}`);
    return false;
  }
}

async function processPendingMint(tx) {
  const attempts = mintingAttempts.get(tx.txid) || 0;
  
  if (attempts >= config.maxRetries) {
    await logToFile(`Max retries reached for transaction ${tx.txid}`);
    return;
  }

  if (activeOperations.has(tx.txid)) {
    await logToFile(`Mint operation already in progress for ${tx.txid}`);
    return;
  }

  activeOperations.add(tx.txid);

  try {
    await logToFile(`Processing mint for transaction ${tx.txid} (attempt ${attempts + 1}/${config.maxRetries})`);
    
    if (!tx.sender_address) {
      await logToFile(`No sender address found for transaction ${tx.txid}, skipping`);
      mintingAttempts.set(tx.txid, config.maxRetries);
      return;
    }

    const mintResult = await executeMintCommand(tx.sender_address, tx.txid);
    
    if (mintResult.success && mintResult.inscriptionId) {
      const confirmSuccess = await confirmMint(tx.txid, mintResult.inscriptionId);
      
      if (confirmSuccess) {
        mintingAttempts.delete(tx.txid);
        await logToFile(`Successfully minted bitbar for transaction ${tx.txid} to ${tx.sender_address}`);
        return;
      }
    }
    
    mintingAttempts.set(tx.txid, attempts + 1);
    await logToFile(`Will retry transaction ${tx.txid} later (attempt ${attempts + 1})`);
    
  } catch (error) {
    await logToFile(`Error processing mint for transaction ${tx.txid}: ${error.message}`);
    mintingAttempts.set(tx.txid, attempts + 1);
  } finally {
    activeOperations.delete(tx.txid);
  }
}

async function checkPendingMints() {
  try {
    await logToFile('Checking for pending mints...');
    const response = await axios.get(`${config.monitorUrl}/api/pending-mints`);
    const pendingMints = response.data;

    if (pendingMints.length === 0) {
      await logToFile('No pending mints found');
      return;
    }

    await logToFile(`Found ${pendingMints.length} pending mints`);
    
    for (const tx of pendingMints) {
      if (activeOperations.has(tx.txid)) {
        continue;
      }
      
      await processPendingMint(tx);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

  } catch (error) {
    if (error.code === 'ECONNREFUSED') {
      await logToFile('Could not connect to monitor server. Is it running?');
    } else {
      await logToFile(`Error checking pending mints: ${error.message}`);
    }
  }
}

async function getServiceStatus() {
  const status = {
    uptime: process.uptime(),
    activeOperations: Array.from(activeOperations),
    pendingRetries: Array.from(mintingAttempts.entries()).map(([txid, attempts]) => ({
      txid,
      attempts,
      maxRetries: config.maxRetries
    })),
    totalMints: (await readMints()).length,
    config: {
      walletName: config.walletName,
      filePath: config.filePath,
      monitorUrl: config.monitorUrl,
      checkInterval: config.checkInterval
    }
  };
  return status;
}

async function startMintingService() {
  await initMintsFile();
  await logToFile('Starting bitbar minting service...');
  await logToFile(`Using wallet: ${config.walletName}`);
  await logToFile(`Using file: ${config.filePath}`);
  await logToFile(`Monitoring ${config.monitorUrl} for pending mints`);
  
  const http = require('http');
  const statusServer = http.createServer(async (req, res) => {
    if (req.url === '/status') {
      const status = await getServiceStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
    } else if (req.url === '/mints') {
      const mints = await readMints();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mints, null, 2));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  statusServer.listen(3001, () => {
    logToFile('Status endpoint available at http://localhost:3001/status');
    logToFile('Mints endpoint available at http://localhost:3001/mints');
  });

  while (true) {
    await checkPendingMints();
    await new Promise(resolve => setTimeout(resolve, config.checkInterval));
  }
}

process.on('SIGINT', async () => {
  await logToFile('Shutting down minting service...');
  process.exit(0);
});

process.on('uncaughtException', async (error) => {
  await logToFile(`Uncaught exception: ${error.message}`);
  await logToFile(error.stack);
});

process.on('unhandledRejection', async (error) => {
  await logToFile(`Unhandled rejection: ${error.message}`);
  await logToFile(error.stack);
});

startMintingService().catch(async error => {
  await logToFile(`Fatal error: ${error.message}`);
  process.exit(1);
});
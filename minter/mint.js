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
  monitorUrl: process.env.SERVER_URL || 'http://170.75.164.200:3000', // Updated to use "server" as default
  checkInterval: 30000,
  mintCommandTemplate: `ord wallet --name {wallet} inscribe --file {file} --fee-rate 3 --postage "546 sats" --destination {destination}`,
  maxRetries: 3,
  retryDelay: 5000,
};

async function checkPendingMints() {
  let retries = 0;
  while (retries < config.maxRetries) {
    try {
      const response = await axios.get(`${config.monitorUrl}/api/pending-mints`, { timeout: 5000 });
      console.log('Connected to monitor server and checked for pending mints.');
      const pendingMints = response.data;

      if (pendingMints.length > 0) {
        console.log(`${pendingMints.length} transactions require minting.`);
        for (const mint of pendingMints) {
          await processMint(mint);
        }
      } else {
        console.log('No pending mints found.');
      }
      break; // Exit the loop if the request is successful
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        console.error('Error in monitoring process: AxiosError: timeout of 5000ms exceeded');
      } else if (error.response && error.response.status === 404) {
        console.error('Error in monitoring process: Request failed with status code 404');
      } else {
        console.error('Error in monitoring process:', error.message);
      }
      retries++;
      if (retries < config.maxRetries) {
        console.log(`Retrying in ${config.retryDelay / 1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, config.retryDelay));
      } else {
        console.error('Max retries reached. Exiting monitoring process.');
      }
    }
  }
}

async function processMint(mint) {
  console.log(`Processing mint for transaction ${mint.txid}...`);
  const destination = mint.sender_address;
  const mintCommand = config.mintCommandTemplate
    .replace('{wallet}', walletName)
    .replace('{file}', filePath)
    .replace('{destination}', destination);

  try {
    const { stdout, stderr } = await execAsync(mintCommand);
    if (stdout) console.log(`Mint successful for ${mint.txid}: ${stdout}`);
    if (stderr) console.error(`Mint warnings/errors for ${mint.txid}: ${stderr}`);

    // Log success to the monitor server
    await axios.post(`${config.monitorUrl}/api/confirm-mint`, {
      txid: mint.txid,
      inscription_id: parseInscriptionId(stdout),
    });

    console.log(`Mint confirmed for ${mint.txid}.`);
  } catch (error) {
    console.error(`Error minting transaction ${mint.txid}:`, error.message);
  }
}

function parseInscriptionId(output) {
  // Extract the inscription ID from the command output
  const match = output.match(/inscription_id: (\S+)/);
  return match ? match[1] : null;
}

console.log('Starting bitbar minting service...');
console.log(`Using wallet: ${walletName}`);
console.log(`Using file: ${filePath}`);
console.log(`Monitoring ${config.monitorUrl} for pending mints`);

checkPendingMints();

async function initMintsFile() {
  const mintsFilePath = path.join(__dirname, 'mints.json');
  try {
    await fsPromises.access(mintsFilePath);
  } catch (error) {
    await fsPromises.writeFile(mintsFilePath, JSON.stringify([]));
  }
}

async function logToFile(message) {
  const logFilePath = path.join(__dirname, 'minting.log');
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}\n`;
  await fsPromises.appendFile(logFilePath, logMessage);
}

async function readMints() {
  const mintsFilePath = path.join(__dirname, 'mints.json');
  const mintsData = await fsPromises.readFile(mintsFilePath, 'utf8');
  return JSON.parse(mintsData);
}

async function writeMints(mints) {
  const mintsFilePath = path.join(__dirname, 'mints.json');
  await fsPromises.writeFile(mintsFilePath, JSON.stringify(mints, null, 2));
}

async function getServiceStatus() {
  const status = {
    uptime: process.uptime(),
    totalMints: (await readMints()).length,
    config: {
      walletName,
      filePath,
      monitorUrl: config.monitorUrl,
      checkInterval: config.checkInterval,
    },
  };
  return status;
}

async function startMintingService() {
  await initMintsFile();
  await logToFile('Starting bitbar minting service...');
  await logToFile(`Using wallet: ${walletName}`);
  await logToFile(`Using file: ${filePath}`);
  await logToFile(`Monitoring ${config.monitorUrl} for pending mints`);
}

startMintingService();
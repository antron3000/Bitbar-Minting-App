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
    totalMints: (await readMints()).length
  };
  return status;
}

async function startMonitoring() {
  await initMintsFile();
  await logToFile('Starting bitbar minting service...');
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

startMonitoring().catch(async error => {
  await logToFile(`Fatal error: ${error.message}`);
  process.exit(1);
});
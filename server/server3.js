const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Add body parser for JSON
app.use(express.json());

// Configuration
const config = {
  bitcoinAddress: 'bc1pte4f7x5e5xpr6u2y3rr9mfynw989u9g8zlp7hg0pgc89n5tt3r7qevnwpr',
  checkInterval: 10000,
  apiBaseUrl: 'https://blockstream.info/api',
  maxTransactionHistory: 1000,
  minimumSatsForBitbar: 1641
};

// Enhanced transaction store with minting status
const transactionStore = new Map();

// Separate store for pending mints
const pendingMints = new Map();

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: 'Too many requests from this IP, please try again later.'
});

app.use(limiter);

// Security headers middleware
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

async function fetchTransactions(address) {
  try {
    const response = await axios.get(
      `${config.apiBaseUrl}/address/${address}/txs`,
      {
        timeout: 5000,
        headers: {
          'Accept': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching transactions:', error.message);
    return [];
  }
}

async function fetchTransactionDetails(txid) {
  try {
    const response = await axios.get(
      `${config.apiBaseUrl}/tx/${txid}`,
      {
        timeout: 5000,
        headers: {
          'Accept': 'application/json'
        }
      }
    );
    return response.data;
  } catch (error) {
    console.error('Error fetching transaction details:', error.message);
    return null;
  }
}

async function processTransaction(transaction) {
  if (transactionStore.has(transaction.txid)) {
    return null;
  }

  // Fetch detailed transaction info to get input addresses
  const txDetails = await fetchTransactionDetails(transaction.txid);
  let senderAddress = null;

  if (txDetails && txDetails.vin && txDetails.vin[0] && txDetails.vin[0].prevout) {
    senderAddress = txDetails.vin[0].prevout.scriptpubkey_address;
  }

  const receivedAmount = transaction.vout.reduce((total, output) => {
    if (output.scriptpubkey_address === config.bitcoinAddress) {
      return total + output.value;
    }
    return total;
  }, 0);

  const txInfo = {
    txid: transaction.txid,
    timestamp: Date.now(),
    amount: receivedAmount,
    blockHeight: transaction.status.block_height,
    requiresMinting: receivedAmount >= config.minimumSatsForBitbar,
    mintingStatus: receivedAmount >= config.minimumSatsForBitbar ? 'pending' : 'not_required',
    senderAddress: senderAddress,
    confirmations: 0
  };

  // Maintain size limit for transaction store
  if (transactionStore.size >= config.maxTransactionHistory) {
    const oldestTx = Array.from(transactionStore.entries())
      .sort(([, a], [, b]) => a.timestamp - b.timestamp)[0];
    if (oldestTx) {
      transactionStore.delete(oldestTx[0]);
    }
  }

  transactionStore.set(transaction.txid, txInfo);

  // Add to pending mints if needed
  if (txInfo.requiresMinting && senderAddress) {
    pendingMints.set(transaction.txid, txInfo);
    console.log(`New transaction requiring minting: ${transaction.txid} from ${senderAddress}`);
  }

  return txInfo;
}

async function monitorAddress() {
  try {
    console.log('Checking for new transactions...');
    const transactions = await fetchTransactions(config.bitcoinAddress);
    
    for (const tx of transactions) {
      const newTx = await processTransaction(tx);
      if (newTx) {
        console.log(`New transaction: ${newTx.txid}, Amount: ${newTx.amount} sats, Sender: ${newTx.senderAddress}`);
      }
    }
  } catch (error) {
    console.error('Error in monitoring process:', error);
  }
}

// HTML template with minting status
const getHtmlTemplate = (transactions) => `
  <!DOCTYPE html>
  <html>
    <head>
      <title>Bitcoin Transaction Monitor</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .transaction { margin: 10px 0; padding: 10px; border: 1px solid #ddd; }
        .minting-status { 
          display: inline-block;
          padding: 3px 8px;
          border-radius: 3px;
          font-size: 0.9em;
        }
        .pending { background: #fff3cd; }
        .completed { background: #d4edda; }
        .not-required { background: #e2e3e5; }
      </style>
    </head>
    <body>
      <h1>Bitcoin Transaction Monitor</h1>
      <p>Monitoring address: ${config.bitcoinAddress}</p>
      <p>Minimum sats for bitbar: ${config.minimumSatsForBitbar}</p>
      <p><a href="/qrcode">View QR Code</a></p>
      <h2>Recent Transactions:</h2>
      ${transactions}
    </body>
  </html>
`;

// Routes
app.get('/', (req, res) => {
  const transactionHtml = Array.from(transactionStore.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .map(tx => `
      <div class="transaction">
        <strong>Transaction ID:</strong> ${tx.txid}<br>
        <strong>Amount:</strong> ${tx.amount} sats<br>
        <strong>Sender:</strong> ${tx.senderAddress || 'Unknown'}<br>
        <strong>Time:</strong> ${new Date(tx.timestamp).toLocaleString()}<br>
        <strong>Minting Status:</strong> 
        <span class="minting-status ${tx.mintingStatus}">
          ${tx.mintingStatus.charAt(0).toUpperCase() + tx.mintingStatus.slice(1)}
        </span><br>
        ${tx.blockHeight ? `<strong>Block Height:</strong> ${tx.blockHeight}` : 'Unconfirmed'}
      </div>
    `)
    .join('');

  res.send(getHtmlTemplate(transactionHtml || 'No transactions yet.'));
});

app.get('/qrcode', async (req, res) => {
  try {
    const qrCodeBuffer = await qrcode.toBuffer(config.bitcoinAddress);
    res.type('png');
    res.send(qrCodeBuffer);
  } catch (error) {
    console.error('Error generating QR code:', error);
    res.status(500).send('Error generating QR code');
  }
});

// API endpoints
app.get('/api/pending-mints', (req, res) => {
  const pendingMintsArray = Array.from(pendingMints.values())
    .filter(tx => tx.mintingStatus === 'pending')
    .map(tx => ({
      txid: tx.txid,
      amount: tx.amount,
      timestamp: tx.timestamp,
      senderAddress: tx.senderAddress
    }));
  
  res.json(pendingMintsArray);
});

app.post('/api/confirm-mint', (req, res) => {
  const { txid } = req.body;
  
  if (!txid) {
    return res.status(400).json({ error: 'Transaction ID required' });
  }

  const transaction = transactionStore.get(txid);
  
  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  if (transaction.mintingStatus === 'completed') {
    return res.status(400).json({ error: 'Transaction already minted' });
  }

  // Update minting status
  transaction.mintingStatus = 'completed';
  transactionStore.set(txid, transaction);
  
  // Remove from pending mints
  pendingMints.delete(txid);

  console.log(`Bitbar minted for transaction ${txid}`);
  res.json({ success: true, transaction });
});

// Status endpoint
app.get('/api/status', (req, res) => {
  const status = {
    totalTransactions: transactionStore.size,
    pendingMints: pendingMints.size,
    uptime: process.uptime(),
    lastCheck: new Date().toISOString()
  };
  res.json(status);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send('Something broke!');
});

// Start monitoring and server
const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  setInterval(monitorAddress, config.checkInterval);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

module.exports = app;

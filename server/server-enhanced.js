const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const config = {
  // Move address to environment variable in production
  bitcoinAddress: 'bc1pte4f7x5e5xpr6u2y3rr9mfynw989u9g8zlp7hg0pgc89n5tt3r7qevnwpr',
  checkInterval: 10000, // 10 seconds
  apiBaseUrl: 'https://blockstream.info/api',
  maxTransactionHistory: 1000, // Limit stored transaction history
};

// Use a Map instead of Set to store transaction details with timestamps
const transactionStore = new Map();

// Rate limiting middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});

app.use(limiter);

// Add basic security headers
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

function processTransaction(transaction) {
  if (transactionStore.has(transaction.txid)) {
    return null;
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
    blockHeight: transaction.status.block_height
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
  return txInfo;
}

async function monitorAddress() {
  try {
    console.log('Checking for new transactions...');
    const transactions = await fetchTransactions(config.bitcoinAddress);
    
    const newTransactions = transactions
      .map(processTransaction)
      .filter(tx => tx !== null);

    if (newTransactions.length > 0) {
      newTransactions.forEach(tx => {
        console.log(`New transaction: ${tx.txid}, Amount: ${tx.amount} sats`);
      });
    }
  } catch (error) {
    console.error('Error in monitoring process:', error);
  }
}

// HTML template for the main page
const getHtmlTemplate = (transactions) => `
  <!DOCTYPE html>
  <html>
    <head>
      <title>Bitcoin Transaction Monitor</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .transaction { margin: 10px 0; padding: 10px; border: 1px solid #ddd; }
      </style>
    </head>
    <body>
      <h1>Bitcoin Transaction Monitor</h1>
      <p>Monitoring address: ${config.bitcoinAddress}</p>
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
        <strong>Time:</strong> ${new Date(tx.timestamp).toLocaleString()}<br>
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

module.exports = app; // For testing purposes

const express = require('express');
const axios = require('axios');
const qrcode = require('qrcode');
const rateLimit = require('express-rate-limit');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

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
  minimumSatsForBitbar: 1641,
  dbPath: path.join(__dirname, 'transactions.db')
};

// Database setup
let db;

async function initializeDatabase() {
  db = await open({
    filename: config.dbPath,
    driver: sqlite3.Database
  });

  // Create transactions table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS transactions (
      txid TEXT PRIMARY KEY,
      timestamp INTEGER,
      amount INTEGER,
      block_height INTEGER,
      requires_minting BOOLEAN,
      minting_status TEXT,
      sender_address TEXT,
      confirmations INTEGER,
      inscription_id TEXT,
      inscription_timestamp INTEGER
    )
  `);

  // Create index for faster queries
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_minting_status 
    ON transactions(minting_status)
  `);
}

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
  // Check if transaction already exists
  const existingTx = await db.get('SELECT * FROM transactions WHERE txid = ?', transaction.txid);
  if (existingTx) {
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
    block_height: transaction.status.block_height,
    requires_minting: receivedAmount >= config.minimumSatsForBitbar ? 1 : 0,
    minting_status: receivedAmount >= config.minimumSatsForBitbar ? 'pending' : 'not_required',
    sender_address: senderAddress,
    confirmations: 0
  };

  // Insert transaction into database
  await db.run(`
    INSERT INTO transactions (
      txid, timestamp, amount, block_height, requires_minting, 
      minting_status, sender_address, confirmations
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      txInfo.txid, txInfo.timestamp, txInfo.amount, txInfo.block_height,
      txInfo.requires_minting, txInfo.minting_status, txInfo.sender_address,
      txInfo.confirmations
    ]
  );

  if (txInfo.requires_minting && senderAddress) {
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
        console.log(`New transaction: ${newTx.txid}, Amount: ${newTx.amount} sats, Sender: ${newTx.sender_address}`);
      }
    }

    // Clean up old transactions
    await db.run(`
      DELETE FROM transactions 
      WHERE timestamp < ? 
      AND minting_status != 'pending'`,
      [Date.now() - (30 * 24 * 60 * 60 * 1000)] // Keep last 30 days
    );
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
app.get('/', async (req, res) => {
  const transactions = await db.all(
    'SELECT * FROM transactions ORDER BY timestamp DESC LIMIT 100'
  );

  const transactionHtml = transactions.map(tx => `
    <div class="transaction">
      <strong>Transaction ID:</strong> ${tx.txid}<br>
      <strong>Amount:</strong> ${tx.amount} sats<br>
      <strong>Sender:</strong> ${tx.sender_address || 'Unknown'}<br>
      <strong>Time:</strong> ${new Date(tx.timestamp).toLocaleString()}<br>
      <strong>Minting Status:</strong> 
      <span class="minting-status ${tx.minting_status}">
        ${tx.minting_status.charAt(0).toUpperCase() + tx.minting_status.slice(1)}
      </span><br>
      ${tx.block_height ? `<strong>Block Height:</strong> ${tx.block_height}` : 'Unconfirmed'}
      ${tx.inscription_id ? `<br><strong>Inscription ID:</strong> ${tx.inscription_id}` : ''}
    </div>
  `).join('');

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
app.get('/api/pending-mints', async (req, res) => {
  const pendingMints = await db.all(`
    SELECT txid, amount, timestamp, sender_address 
    FROM transactions 
    WHERE minting_status = 'pending'
  `);
  res.json(pendingMints);
});

app.post('/api/confirm-mint', async (req, res) => {
  const { txid, inscription_id } = req.body;
  
  if (!txid) {
    return res.status(400).json({ error: 'Transaction ID required' });
  }

  const transaction = await db.get('SELECT * FROM transactions WHERE txid = ?', txid);
  
  if (!transaction) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  if (transaction.minting_status === 'completed') {
    return res.status(400).json({ error: 'Transaction already minted' });
  }

  // Update minting status and inscription details
  await db.run(`
    UPDATE transactions 
    SET minting_status = 'completed',
        inscription_id = ?,
        inscription_timestamp = ?
    WHERE txid = ?`,
    [inscription_id, Date.now(), txid]
  );

  console.log(`Bitbar minted for transaction ${txid}`);
  res.json({ success: true, transaction });
});

// Status endpoint
app.get('/api/status', async (req, res) => {
  const [totalCount, pendingCount] = await Promise.all([
    db.get('SELECT COUNT(*) as count FROM transactions'),
    db.get('SELECT COUNT(*) as count FROM transactions WHERE minting_status = ?', ['pending'])
  ]);

  const status = {
    totalTransactions: totalCount.count,
    pendingMints: pendingCount.count,
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

// Initialize database and start server
async function startServer() {
  try {
    await initializeDatabase();
    
    const server = app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      setInterval(monitorAddress, config.checkInterval);
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM signal received: closing HTTP server');
      server.close(async () => {
        console.log('HTTP server closed');
        await db.close();
      });
    });

  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

startServer();

module.exports = app;
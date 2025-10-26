const express = require('express');
const fs = require('fs');

const app = express();
const DATABASE_PATH = 'database.json';

// Middleware to parse JSON bodies
app.use(express.json());

// Serve static files (for index.html, script.js, style.css)
app.use(express.static(__dirname));

/**
 * GET /api/database
 * Returns the current contents of the database JSON file.
 */
app.get('/api/database', (req, res) => {
  fs.readFile(DATABASE_PATH, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to read database' });
    }
    try {
      const json = JSON.parse(data || '{}');
      res.json(json);
    } catch (parseError) {
      res.status(500).json({ error: 'Invalid database format' });
    }
  });
});

/**
 * POST /api/products
 * Adds a new product to the database JSON file.
 * Expects the new product object in the request body.
 */
app.post('/api/products', (req, res) => {
  const newProduct = req.body;
  if (!newProduct) {
    return res.status(400).json({ error: 'Missing product data' });
  }
  fs.readFile(DATABASE_PATH, 'utf8', (err, data) => {
    let db = { products: [], salesData: [], debtData: [] };
    if (!err) {
      try {
        db = JSON.parse(data);
      } catch (parseErr) {
        // ignore parse error and start with empty db
      }
    }
    // Assign an ID if not provided
    if (!newProduct.id) {
      newProduct.id = Date.now();
    }
    db.products = db.products || [];
    db.products.push(newProduct);
    fs.writeFile(DATABASE_PATH, JSON.stringify(db, null, 4), (writeErr) => {
      if (writeErr) {
        return res.status(500).json({ error: 'Failed to write database' });
      }
      res.json({ success: true, product: newProduct });
    });
  });
});

// Start the server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
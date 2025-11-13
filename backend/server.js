// server.js -- Backend todo en 1 archivo
// Requisitos: npm i express dotenv nano bcrypt jsonwebtoken uuid multer nodemailer pdfkit cors exceljs
// Uso: copiar .env, llenar, luego: node server.js

const dotenv = require('dotenv');
const express = require('express');
const cors = require('cors');
const Nano = require('nano');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

dotenv.config({path: './.env'});


const app = express();
app.use(cors()); // CORS abierto como pediste
app.use(express.json({ limit: '10mb' })); // permitir JSON grande por base64
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

const upload = multer(); // usaremos multer para recibir photo multipart/form-data

// --- Config / CouchDB init ---
const COUCH_URL = process.env.COUCH_URL || 'http://admin:admin@127.0.0.1:5984';
const USERS_DB = process.env.COUCH_DB_USERS || 'users';
const PRODUCTS_DB = process.env.COUCH_DB_PRODUCTS || 'products';
const SALES_DB = process.env.COUCH_DB_SALES || 'sales';
const CUSTOMERS_DB = process.env.COUCH_DB_CUSTOMERS || 'customers';
const JWT_SECRET = process.env.JWT_SECRET || 'secret_jwt_change_me';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4000';

const nano = Nano(COUCH_URL);
let usersDb = null;
let productsDb = null;
let salesDb = null;
let customersDb = null;

async function ensureDB(name) {
  try {
    await nano.db.get(name);
  } catch (e) {
    await nano.db.create(name);
  }
}

async function initDbs() {
  await ensureDB(USERS_DB);
  await ensureDB(PRODUCTS_DB);
  await ensureDB(SALES_DB);
  await ensureDB(CUSTOMERS_DB);
  usersDb = nano.db.use(USERS_DB);
  productsDb = nano.db.use(PRODUCTS_DB);
  salesDb = nano.db.use(SALES_DB);
  customersDb = nano.db.use(CUSTOMERS_DB);
}
initDbs().catch(err => {
  console.error('Error inicializando CouchDB:', err);
  process.exit(1);
});

// --- Nodemailer setup ---
const smtpHost = process.env.SMTP_HOST;
const smtpPort = process.env.SMTP_PORT;
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;

let mailTransport = null;
if (smtpHost && smtpUser && smtpPass) {
  mailTransport = nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort ? parseInt(smtpPort) : 587,
    secure: false,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });
} else {
  console.warn('SMTP not fully configured. Password reset emails will fail unless you set SMTP_HOST, SMTP_USER, SMTP_PASS in .env');
}

// --- Helpers ---
function sanitizeProductInput(body) {
  // validaciones básicas
  const name = (body.name || '').toString().trim();
  const description = (body.description || '').toString().trim();
  const price = Number(body.price || 0);
  const stock = parseInt(body.stock || 0);
  if (!name) throw new Error('Nombre es requerido');
  if (Number.isNaN(price) || price < 0) throw new Error('Precio inválido');
  if (Number.isNaN(stock) || stock < 0) throw new Error('Stock inválido');
  return { name, description, price, stock };
}

async function findUserByEmail(email) {
  // busqueda simple con _find sería ideal, pero para compatibilidad usamos view por _all_docs + filter
  // nano tiene mango queries: use db.find
  const db = usersDb;
  const selector = { email };
  const result = await db.find({ selector, limit: 1 });
  if (result.docs && result.docs.length) return result.docs[0];
  return null;
}

// --- Auth endpoints ---
// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'email y password son requeridos' });

    const exists = await findUserByEmail(email);
    if (exists) return res.status(400).json({ message: 'Usuario ya existe' });

    const hashed = await bcrypt.hash(password, 10);
    const id = `user:${uuidv4()}`;
    const userDoc = {
      _id: id,
      email,
      name: name || '',
      passwordHash: hashed,
      createdAt: new Date().toISOString()
    };
    await usersDb.insert(userDoc);
    return res.status(201).json({ message: 'Usuario creado' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error al registrar usuario' });
  }
});

// Login -> devuelve JWT simple
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await findUserByEmail(email);
    if (!user) return res.status(400).json({ message: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, user.passwordHash || '');
    if (!ok) return res.status(400).json({ message: 'Credenciales inválidas' });

    const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error al iniciar sesión' });
  }
});

// Request password reset -> genera token, guarda y envía correo
app.post('/api/auth/request-reset', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email requerido' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    const token = uuidv4();
    const expiresAt = Date.now() + 1000 * 60 * 60; // 1 hora
    user.resetToken = token;
    user.resetExpires = expiresAt;
    await usersDb.insert(user); // requiere _rev que ya está

    if (!mailTransport) {
      console.warn('No mail transport configured - returning token in response for dev purposes');
      return res.json({ message: 'Token generado (SMTP no configurado)', token });
    }

    const resetLink = `${APP_BASE_URL}/reset-password.html?token=${token}&email=${encodeURIComponent(email)}`;
    const mail = {
      from: process.env.SMTP_FROM || smtpUser,
      to: email,
      subject: 'Solicitud de restablecimiento de contraseña',
      html: `<p>Se solicitó restablecer la contraseña. Si fue usted, abra este enlace y ponga su nueva contraseña:</p>
             <p><a href="${resetLink}">${resetLink}</a></p>
             <p>Si no solicitó este cambio, ignore este correo.</p>`
    };

    await mailTransport.sendMail(mail);
    return res.json({ message: 'Correo de restablecimiento enviado' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error al solicitar restablecimiento' });
  }
});

// Reset password -> recibe email, token, newPassword
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword) return res.status(400).json({ message: 'email, token y newPassword son requeridos' });

    const user = await findUserByEmail(email);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (!user.resetToken || user.resetToken !== token) return res.status(400).json({ message: 'Token inválido' });
    if (!user.resetExpires || Date.now() > user.resetExpires) return res.status(400).json({ message: 'Token expirado' });

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    delete user.resetToken;
    delete user.resetExpires;
    await usersDb.insert(user);

    return res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error al restablecer contraseña' });
  }
});

// Middleware simple para proteger rutas (espera header Authorization: Bearer <token>)
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ message: 'No autorizado' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ message: 'Formato de token inválido' });
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Token inválido' });
  }
}

// --- Products CRUD ---
// Create product (multipart/form-data with optional 'photo' file OR JSON with photoBase64)
app.post('/api/products', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const { name, description, price, stock } = req.body;
    const prod = sanitizeProductInput({ name, description, price, stock });

    const id = `product:${uuidv4()}`;
    const createdAt = new Date().toISOString();
    const doc = {
      _id: id,
      name: prod.name,
      description: prod.description,
      price: prod.price,
      stock: prod.stock,
      createdAt
    };

    // manejamos foto: puede venir como archivo multipart o como campo base64
    if (req.file && req.file.buffer) {
      doc.photoBase64 = req.file.buffer.toString('base64');
      doc.photoMime = req.file.mimetype || 'image/jpeg';
    } else if (req.body.photoBase64) {
      // si frontend envía la imagen en base64 (por ejemplo data URI o raw base64)
      let raw = req.body.photoBase64;
      // quitar prefijo data:*/*;base64, si existe
      const commaIndex = raw.indexOf(',');
      if (commaIndex !== -1) raw = raw.slice(commaIndex + 1);
      doc.photoBase64 = raw;
      doc.photoMime = req.body.photoMime || 'image/jpeg';
    }

    await productsDb.insert(doc);
    return res.status(201).json({ message: 'Producto creado', id: doc._id });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: err.message || 'Error creando producto' });
  }
});

// Get all products (lista)
app.get('/api/products', async (req, res) => {
  try {
    // usar find con selector vacío para traer todos
    const result = await productsDb.find({ selector: {}, limit: 1000 });
    const items = (result.docs || []).map(d => ({
      id: d._id,
      name: d.name,
      description: d.description,
      price: d.price,
      stock: d.stock,
      createdAt: d.createdAt,
      hasPhoto: !!d.photoBase64,
      photoBase64: d.photoBase64 ? `data:${d.photoMime || 'image/jpeg'};base64,${d.photoBase64}` : null
    }));
    return res.json(items);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error listando productos' });
  }
});

// Get product by id
app.get('/api/products/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await productsDb.get(id);
    const out = {
      id: doc._id,
      name: doc.name,
      description: doc.description,
      price: doc.price,
      stock: doc.stock,
      createdAt: doc.createdAt,
      photoBase64: doc.photoBase64 ? `data:${doc.photoMime};base64,${doc.photoBase64}` : null
    };
    return res.json(out);
  } catch (err) {
    console.error(err);
    return res.status(404).json({ message: 'Producto no encontrado' });
  }
});

// Update product (multipart/form-data optional photo)
app.put('/api/products/:id', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await productsDb.get(id);
    const { name, description, price, stock } = req.body;

    if (name !== undefined) doc.name = name;
    if (description !== undefined) doc.description = description;
    if (price !== undefined) doc.price = Number(price);
    if (stock !== undefined) doc.stock = parseInt(stock);

    // actualizar foto si viene
    if (req.file && req.file.buffer) {
      doc.photoBase64 = req.file.buffer.toString('base64');
      doc.photoMime = req.file.mimetype || 'image/jpeg';
    } else if (req.body.photoBase64) {
      let raw = req.body.photoBase64;
      const commaIndex = raw.indexOf(',');
      if (commaIndex !== -1) raw = raw.slice(commaIndex + 1);
      doc.photoBase64 = raw;
      doc.photoMime = req.body.photoMime || 'image/jpeg';
    }

    await productsDb.insert(doc);
    return res.json({ message: 'Producto actualizado' });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: 'Error actualizando producto' });
  }
});

// Delete product
app.delete('/api/products/:id', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await productsDb.get(id);
    await productsDb.destroy(doc._id, doc._rev);
    return res.json({ message: 'Producto eliminado' });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: 'Error eliminando producto' });
  }
});

// --- Customers CRUD ---
// Create customer
app.post('/api/customers', async (req, res) => {
  try {
    const { name, email, phone, address } = req.body;
    if (!name) return res.status(400).json({ message: 'Nombre es requerido' });

    const id = `customer:${uuidv4()}`;
    const customerDoc = {
      _id: id,
      name: name.trim(),
      email: email ? email.trim() : '',
      phone: phone ? phone.trim() : '',
      address: address ? address.trim() : '',
      createdAt: new Date().toISOString()
    };

    await customersDb.insert(customerDoc);
    return res.status(201).json({ message: 'Cliente creado', id: customerDoc._id, customer: customerDoc });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error al crear cliente' });
  }
});

// Get all customers
app.get('/api/customers', async (req, res) => {
  try {
    const result = await customersDb.find({ selector: {}, limit: 1000 });
    const items = (result.docs || []).map(d => ({
      id: d._id,
      name: d.name,
      email: d.email,
      phone: d.phone,
      address: d.address,
      createdAt: d.createdAt
    }));
    return res.json(items);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error listando clientes' });
  }
});

// Get customer by id
app.get('/api/customers/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await customersDb.get(id);
    return res.json({
      id: doc._id,
      name: doc.name,
      email: doc.email,
      phone: doc.phone,
      address: doc.address,
      createdAt: doc.createdAt
    });
  } catch (err) {
    console.error(err);
    return res.status(404).json({ message: 'Cliente no encontrado' });
  }
});

// --- Sales endpoints ---
// Create sale (buy products and register sale)
app.post('/api/sales', async (req, res) => {
  try {
    const { customerId, customerName, items } = req.body;
    // items = [ { productId, quantity }, ... ]
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Items son requeridos' });
    }

    // Validar y obtener productos
    const saleItems = [];
    let total = 0;

    for (const item of items) {
      const productId = item.productId;
      const quantity = parseInt(item.quantity || 1);
      if (quantity <= 0) return res.status(400).json({ message: 'Cantidad inválida' });

      const productDoc = await productsDb.get(productId);
      if (productDoc.stock === undefined || productDoc.stock < quantity) {
        return res.status(400).json({ message: `Stock insuficiente para producto ${productDoc.name}` });
      }

      const itemTotal = productDoc.price * quantity;
      saleItems.push({
        productId: productDoc._id,
        productName: productDoc.name,
        quantity,
        unitPrice: productDoc.price,
        total: itemTotal
      });
      total += itemTotal;

      // Decrementar stock
      productDoc.stock -= quantity;
      await productsDb.insert(productDoc);
    }

    // Crear venta
    const saleId = `sale:${uuidv4()}`;
    const saleDoc = {
      _id: saleId,
      customerId: customerId || 'guest',
      customerName: customerName || 'Cliente Anónimo',
      items: saleItems,
      total,
      createdAt: new Date().toISOString()
    };

    await salesDb.insert(saleDoc);
    return res.status(201).json({
      message: 'Venta realizada',
      saleId: saleDoc._id,
      total: saleDoc.total
    });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: err.message || 'Error al realizar venta' });
  }
});

// Get all sales
app.get('/api/sales', async (req, res) => {
  try {
    const result = await salesDb.find({ selector: {}, limit: 1000 });
    return res.json(result.docs || []);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error listando ventas' });
  }
});

// Get sale by id
app.get('/api/sales/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await salesDb.get(id);
    return res.json(doc);
  } catch (err) {
    console.error(err);
    return res.status(404).json({ message: 'Venta no encontrada' });
  }
});

// Generate invoice PDF for a specific sale
app.get('/api/sales/:id/invoice', async (req, res) => {
  try {
    const id = req.params.id;
    const sale = await salesDb.get(id);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Disposition', `attachment; filename="factura_${sale._id}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');

    doc.pipe(res);

    // Header
    doc.fontSize(20).text('FACTURA DE VENTA', { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Factura No: ${sale._id}`, { align: 'right' });
    doc.text(`Fecha: ${new Date(sale.createdAt).toLocaleString()}`, { align: 'right' });
    doc.moveDown();

    // Customer info
    doc.fontSize(12).text('CLIENTE:', { underline: true });
    doc.fontSize(10).text(`Nombre: ${sale.customerName}`);
    if (sale.customerId && sale.customerId !== 'guest') {
      doc.text(`ID: ${sale.customerId}`);
    }
    doc.moveDown();

    // Items table header
    doc.fontSize(12).text('PRODUCTOS:', { underline: true });
    doc.moveDown(0.5);

    // Items with images
    doc.font('Helvetica');
    for (const item of sale.items) {
      // Try to load product image
      let productImage = null;
      try {
        const product = await productsDb.get(item.productId);
        if (product.photoBase64) {
          productImage = Buffer.from(product.photoBase64, 'base64');
        }
      } catch (e) {
        // Product not found or no image
      }

      const startY = doc.y;

      // Add image if available
      if (productImage) {
        try {
          doc.image(productImage, 50, startY, { width: 60, height: 60 });
        } catch (imgErr) {
          console.warn('Error adding image to invoice:', imgErr);
        }
      }

      // Product details next to image
      const textX = productImage ? 120 : 50;
      doc.fontSize(11).font('Helvetica-Bold').text(item.productName, textX, startY);
      doc.fontSize(9).font('Helvetica');
      doc.text(`Cantidad: ${item.quantity}`, textX, startY + 15);
      doc.text(`Precio unitario: $${item.unitPrice.toFixed(2)}`, textX, startY + 28);
      doc.text(`Subtotal: $${item.total.toFixed(2)}`, textX, startY + 41);

      // Move down for next item
      doc.moveDown(productImage ? 4 : 3);

      // Add separator line
      doc.strokeColor('#e5e7eb').lineWidth(0.5)
         .moveTo(50, doc.y).lineTo(520, doc.y).stroke();
      doc.moveDown(0.5);
    }

    doc.moveDown();
    doc.strokeColor('#cccccc').lineWidth(1)
       .moveTo(50, doc.y).lineTo(520, doc.y).stroke();
    doc.moveDown();

    // Total
    doc.fontSize(14).font('Helvetica-Bold');
    doc.text('TOTAL:', 330, doc.y, { width: 80, align: 'right' });
    doc.text(`$${sale.total.toFixed(2)}`, 420, doc.y, { width: 80, align: 'right' });

    doc.end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error generando factura' });
  }
});

// Generate inventory PDF (todos los productos con foto)
app.get('/api/products/report/pdf', authMiddleware, async (req, res) => {
  try {
    const result = await productsDb.find({ selector: {}, limit: 1000 });
    const products = result.docs || [];

    // Crear PDF en memoria -> stream
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Disposition', `attachment; filename="inventory_${new Date().toISOString().slice(0,10)}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');

    doc.pipe(res);

    doc.fontSize(18).text('Inventario de Productos', { align: 'center' });
    doc.moveDown();

    // Para cada producto: nombre, precio, stock, descripción, foto (si existe)
    for (const p of products) {
      doc.fontSize(14).text(`${p.name} (ID: ${p._id})`);
      doc.fontSize(11).text(`Precio: ${p.price}    Stock: ${p.stock}`);
      if (p.description) {
        doc.fontSize(10).text(p.description, { width: 450 });
      }

      if (p.photoBase64) {
        try {
          const imgBuffer = Buffer.from(p.photoBase64, 'base64');
          // ajustar imagen con width máximo y mantener aspect
          // PDFKit ubica imagen en coordenadas actuales
          const xBefore = doc.x;
          const yBefore = doc.y;
          // intentamos añadir imagen con fit
          doc.moveDown(0.3);
          doc.image(imgBuffer, { fit: [200, 200] });
          doc.moveDown(0.5);
        } catch (imgErr) {
          console.warn('No se pudo insertar imagen de producto', p._id, imgErr);
          doc.fontSize(9).text('[Imagen inválida]', { oblique: true });
        }
      }

      doc.moveDown(1);
      doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
      doc.moveDown(0.8);
    }

    doc.end();
    // response stream terminado cuando doc.end()
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error generando PDF' });
  }
});

// --- Reports in XLSX format ---
// Report 1: Total sales value
app.get('/api/reports/sales-total', authMiddleware, async (req, res) => {
  try {
    const result = await salesDb.find({ selector: {}, limit: 10000 });
    const sales = result.docs || [];

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte de Ventas');

    // Headers
    worksheet.columns = [
      { header: 'ID Venta', key: 'id', width: 30 },
      { header: 'Cliente', key: 'customer', width: 30 },
      { header: 'Fecha', key: 'date', width: 20 },
      { header: 'Total', key: 'total', width: 15 }
    ];

    // Style headers
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };

    // Add data
    let totalSales = 0;
    for (const sale of sales) {
      worksheet.addRow({
        id: sale._id,
        customer: sale.customerName,
        date: new Date(sale.createdAt).toLocaleString(),
        total: sale.total
      });
      totalSales += sale.total;
    }

    // Add total row
    const totalRow = worksheet.addRow({
      id: '',
      customer: '',
      date: 'TOTAL VENTAS:',
      total: totalSales
    });
    totalRow.font = { bold: true };
    totalRow.getCell('total').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF00' }
    };

    res.setHeader('Content-Disposition', `attachment; filename="reporte_ventas_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error generando reporte de ventas' });
  }
});

// Report 2: Total products in stock
app.get('/api/reports/stock', authMiddleware, async (req, res) => {
  try {
    const result = await productsDb.find({ selector: {}, limit: 10000 });
    const products = result.docs || [];

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Reporte de Stock');

    // Headers
    worksheet.columns = [
      { header: 'ID Producto', key: 'id', width: 30 },
      { header: 'Nombre', key: 'name', width: 30 },
      { header: 'Precio', key: 'price', width: 15 },
      { header: 'Stock Disponible', key: 'stock', width: 20 },
      { header: 'Valor Total Stock', key: 'totalValue', width: 20 }
    ];

    // Style headers
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };

    // Add data
    let totalStock = 0;
    let totalValue = 0;
    for (const product of products) {
      const stock = product.stock || 0;
      const value = stock * product.price;
      worksheet.addRow({
        id: product._id,
        name: product.name,
        price: product.price,
        stock: stock,
        totalValue: value
      });
      totalStock += stock;
      totalValue += value;
    }

    // Add total row
    const totalRow = worksheet.addRow({
      id: '',
      name: '',
      price: '',
      stock: totalStock,
      totalValue: totalValue
    });
    totalRow.font = { bold: true };
    totalRow.getCell('stock').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF00' }
    };
    totalRow.getCell('totalValue').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF00' }
    };

    res.setHeader('Content-Disposition', `attachment; filename="reporte_stock_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error generando reporte de stock' });
  }
});

// Report 3: Total purchases by a single customer
app.get('/api/reports/customer-purchases/:customerId', authMiddleware, async (req, res) => {
  try {
    const customerId = req.params.customerId;

    // Get customer info
    let customerName = 'Cliente';
    try {
      const customer = await customersDb.get(customerId);
      customerName = customer.name;
    } catch (e) {
      // If customer not found, check if it's a name search
      const result = await customersDb.find({
        selector: { name: { $regex: `(?i)${customerId}` } },
        limit: 1
      });
      if (result.docs && result.docs.length > 0) {
        customerName = result.docs[0].name;
      }
    }

    // Get all sales for this customer
    const salesResult = await salesDb.find({
      selector: {
        $or: [
          { customerId: customerId },
          { customerName: { $regex: `(?i)${customerId}` } }
        ]
      },
      limit: 10000
    });
    const sales = salesResult.docs || [];

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Compras del Cliente');

    // Title
    worksheet.mergeCells('A1:E1');
    const titleCell = worksheet.getCell('A1');
    titleCell.value = `Compras del Cliente: ${customerName}`;
    titleCell.font = { bold: true, size: 14 };
    titleCell.alignment = { horizontal: 'center' };

    // Headers
    worksheet.getRow(3).values = ['ID Venta', 'Fecha', 'Productos', 'Cantidad Total', 'Total'];
    worksheet.columns = [
      { key: 'id', width: 30 },
      { key: 'date', width: 20 },
      { key: 'products', width: 40 },
      { key: 'quantity', width: 15 },
      { key: 'total', width: 15 }
    ];

    // Style headers
    worksheet.getRow(3).font = { bold: true };
    worksheet.getRow(3).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFD3D3D3' }
    };

    // Add data
    let totalPurchases = 0;
    let totalQuantity = 0;
    for (const sale of sales) {
      const productsStr = sale.items.map(i => `${i.productName} (x${i.quantity})`).join(', ');
      const qty = sale.items.reduce((sum, i) => sum + i.quantity, 0);

      worksheet.addRow({
        id: sale._id,
        date: new Date(sale.createdAt).toLocaleString(),
        products: productsStr,
        quantity: qty,
        total: sale.total
      });
      totalPurchases += sale.total;
      totalQuantity += qty;
    }

    // Add total row
    const totalRow = worksheet.addRow({
      id: '',
      date: '',
      products: 'TOTAL:',
      quantity: totalQuantity,
      total: totalPurchases
    });
    totalRow.font = { bold: true };
    totalRow.getCell('total').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFF00' }
    };

    res.setHeader('Content-Disposition', `attachment; filename="compras_cliente_${customerId}_${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Error generando reporte de compras del cliente' });
  }
});

// Health
app.get('/ping', (req, res) => res.json({ ok: true }));

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

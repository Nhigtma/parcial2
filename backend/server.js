// server.js -- Backend todo en 1 archivo
// Requisitos: npm i express dotenv nano bcrypt jsonwebtoken uuid multer nodemailer pdfkit cors
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
const JWT_SECRET = process.env.JWT_SECRET || 'secret_jwt_change_me';
const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:4000';

const nano = Nano(COUCH_URL);
let usersDb = null;
let productsDb = null;

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
  usersDb = nano.db.use(USERS_DB);
  productsDb = nano.db.use(PRODUCTS_DB);
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
      hasPhoto: !!d.photoBase64
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

// Buy product (decrement stock)
app.post('/api/products/:id/buy', async (req, res) => {
  try {
    const id = req.params.id;
    const quantity = parseInt(req.body.quantity || 1);
    if (quantity <= 0) return res.status(400).json({ message: 'Cantidad inválida' });

    const doc = await productsDb.get(id);
    if (doc.stock === undefined || doc.stock < quantity) return res.status(400).json({ message: 'Stock insuficiente' });

    doc.stock = doc.stock - quantity;
    await productsDb.insert(doc);
    // opcional: crear un ticket de venta (no solicitado explícitamente)
    return res.json({ message: 'Compra realizada', remainingStock: doc.stock });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: 'Error al comprar producto' });
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

// Health
app.get('/ping', (req, res) => res.json({ ok: true }));

// Start server
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));

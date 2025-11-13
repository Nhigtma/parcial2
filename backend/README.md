# Sistema de Gestión de Inventario

Sistema completo de gestión de inventario con autenticación, ventas, reportes y recuperación de contraseña.

## Características

### PARTE 1: LOGIN
- Inicio de sesión con credenciales (email y contraseña)
- Registro de nuevos usuarios
- Recuperación de contraseña vía correo electrónico

### PARTE 2: MÓDULO DE OPERACIONES
1. **Registro de productos con imagen**: Permite crear productos con toda su información e imagen
2. **Venta de productos**: Sistema de carrito de compras que genera factura PDF automáticamente
3. **Actualización de inventarios (CRUD de productos)**: Gestión completa de productos con visualización de imágenes
4. **Generación de reportes en formato XLSX**:
   - Valor total de ventas realizadas
   - Total de productos en stock
   - Total de compras por un solo cliente (búsqueda por nombre o ID)
5. **Cerrar sesión**: Opción segura para salir del sistema

## Requisitos Previos

- Node.js (v14 o superior)
- CouchDB instalado y en ejecución
- Configuración SMTP (opcional, para recuperación de contraseña)

## Instalación

1. Instalar dependencias:
```bash
npm install
```

2. Crear archivo `.env` con la siguiente configuración:
```env
# CouchDB Configuration
COUCH_URL=http://admin:admin@127.0.0.1:5984
COUCH_DB_USERS=users
COUCH_DB_PRODUCTS=products
COUCH_DB_SALES=sales
COUCH_DB_CUSTOMERS=customers

# JWT Secret
JWT_SECRET=tu_secreto_super_seguro_aqui

# App Configuration
APP_BASE_URL=http://localhost:4000
PORT=4000

# SMTP Configuration (opcional, para recuperación de contraseña)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=tu_correo@gmail.com
SMTP_PASS=tu_contraseña_de_aplicacion
SMTP_FROM=tu_correo@gmail.com
```

## Iniciar la Aplicación

1. Iniciar el servidor:
```bash
npm start
```

2. Abrir `index.html` en tu navegador, o acceder a:
```
http://localhost:4000/index.html
```

## Estructura de la Base de Datos

El sistema crea automáticamente 4 bases de datos en CouchDB:

- **users**: Almacena usuarios del sistema
- **products**: Almacena productos con sus imágenes
- **sales**: Registra todas las ventas realizadas
- **customers**: Almacena información de clientes

## API Endpoints

### Autenticación
- `POST /api/auth/register` - Registrar nuevo usuario
- `POST /api/auth/login` - Iniciar sesión
- `POST /api/auth/request-reset` - Solicitar restablecimiento de contraseña
- `POST /api/auth/reset-password` - Restablecer contraseña

### Productos
- `GET /api/products` - Listar todos los productos
- `GET /api/products/:id` - Obtener producto por ID
- `POST /api/products` - Crear producto (requiere autenticación)
- `PUT /api/products/:id` - Actualizar producto (requiere autenticación)
- `DELETE /api/products/:id` - Eliminar producto (requiere autenticación)
- `GET /api/products/report/pdf` - Generar reporte PDF de inventario (requiere autenticación)

### Clientes
- `GET /api/customers` - Listar todos los clientes
- `GET /api/customers/:id` - Obtener cliente por ID
- `POST /api/customers` - Crear cliente

### Ventas
- `POST /api/sales` - Crear nueva venta
- `GET /api/sales` - Listar todas las ventas
- `GET /api/sales/:id` - Obtener venta por ID
- `GET /api/sales/:id/invoice` - Descargar factura PDF de una venta

### Reportes (requieren autenticación)
- `GET /api/reports/sales-total` - Reporte de valor total de ventas (XLSX)
- `GET /api/reports/stock` - Reporte de productos en stock (XLSX)
- `GET /api/reports/customer-purchases/:customerId` - Reporte de compras por cliente (XLSX)

## Uso de la Aplicación Web

### Primer Uso
1. Abrir `index.html` en el navegador
2. Hacer clic en "¿No tienes cuenta? Regístrate"
3. Llenar el formulario de registro
4. Iniciar sesión con las credenciales creadas

### Gestión de Productos
1. Ir a la pestaña "Gestión de Inventario"
2. Hacer clic en "+ Nuevo Producto"
3. Llenar la información del producto
4. Seleccionar una imagen (opcional)
5. Guardar

### Realizar una Venta
1. Ir a la pestaña "Realizar Venta"
2. Opcionalmente, crear o seleccionar un cliente
3. Agregar productos al carrito usando el botón "Agregar"
4. Ajustar cantidades según sea necesario
5. Hacer clic en "Completar Venta"
6. Se descargará automáticamente la factura en PDF

### Generar Reportes
1. Ir a la pestaña "Reportes"
2. Seleccionar el tipo de reporte deseado:
   - **Reporte de Ventas**: Muestra todas las ventas con su valor total
   - **Reporte de Stock**: Muestra productos en stock con su valor
   - **Compras por Cliente**: Seleccionar cliente y descargar sus compras
3. Hacer clic en "Descargar XLSX"

## Recuperación de Contraseña

Si olvidaste tu contraseña:
1. Hacer clic en "¿Olvidaste tu contraseña?"
2. Ingresar tu correo electrónico
3. Revisar tu correo para obtener el enlace de recuperación
4. Seguir las instrucciones del correo

**Nota**: Para que funcione la recuperación de contraseña, debe configurar correctamente las variables SMTP en el archivo `.env`.

## Validaciones y Seguridad

- Validación de stock antes de realizar ventas
- Autenticación JWT para endpoints protegidos
- Contraseñas hasheadas con bcrypt
- Validación de datos en frontend y backend
- Tokens de recuperación de contraseña con expiración

## Tecnologías Utilizadas

### Backend
- Express.js
- CouchDB (Nano)
- JWT para autenticación
- bcrypt para encriptación de contraseñas
- Multer para manejo de archivos
- PDFKit para generación de PDFs
- ExcelJS para generación de reportes XLSX
- Nodemailer para envío de correos

### Frontend
- HTML5
- CSS3 (diseño moderno y responsive)
- JavaScript vanilla (sin frameworks)

## Solución de Problemas

### Error: Cannot connect to CouchDB
- Verificar que CouchDB esté en ejecución
- Verificar las credenciales en `.env`

### Los correos no se envían
- Verificar configuración SMTP en `.env`
- Para Gmail, usar contraseña de aplicación (no la contraseña normal)

### Las imágenes no se muestran
- Verificar que el producto tenga una imagen cargada
- Verificar permisos de escritura en la base de datos

## Licencia

ISC

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Tesseract = require('tesseract.js'); 

const app = express();
app.use(cors());
app.use(express.json());

if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });
app.use('/uploads', express.static('uploads'));

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

db.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Error BD:', err.message);
    } else {
        console.log('✅ PetHome Conectado a Railway (Pool Seguro e IA Activa)');
        connection.release();
    }
});

const SECRET_KEY = "pethome_clave_super_secreta";

app.post('/register', async (req, res) => {
    const { usuario, nombre, correo, password, telefono } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = `INSERT INTO T_Usuario (Usuario, Nombre, Correo, Contraseña, Telefono) VALUES (?, ?, ?, ?, ?)`;
        
        db.query(sql, [usuario, nombre, correo, hashedPassword, telefono], (err) => {
            if (err) {
                console.error('🚨 CHISME DE MYSQL:', err.sqlMessage);
                return res.status(400).json({ mensaje: 'Error al registrar', detalle: err.sqlMessage });
            }
            res.status(201).json({ mensaje: 'Registrado' });
        });
    } catch (e) { 
        console.error('🚨 ERROR INTERNO:', e);
        res.status(500).json({ mensaje: 'Error interno', detalle: e.toString() }); 
    }
});

app.post('/login', (req, res) => {
    const { correo, password } = req.body;
    db.query(`SELECT * FROM T_Usuario WHERE Correo = ?`, [correo], async (err, results) => {
        if (err || results.length === 0) return res.status(401).json({ mensaje: 'Error' });
        const valid = await bcrypt.compare(password, results[0].Contraseña);
        if (!valid) return res.status(401).json({ mensaje: 'Error' });
        const token = jwt.sign({ id: results[0].ID_Usuario }, SECRET_KEY);
        res.json({ token, usuario: { ID_Usuario: results[0].ID_Usuario, Usuario: results[0].Usuario, Nombre: results[0].Nombre } });
    });
});

app.get('/perfil/:id', (req, res) => {
    const query = "SELECT Nombre as nombre, Usuario as usuario, Fotodeperfil_url as foto_perfil FROM T_Usuario WHERE ID_Usuario = ?";
    db.query(query, [req.params.id], (err, results) => {
        if (err) return res.status(500).json({ error: err.sqlMessage });
        if (results.length > 0) res.json({ success: true, ...results[0] });
        else res.status(404).json({ success: false, message: "No encontrado" });
    });
});

app.put('/perfil', (req, res) => {
    const { id_usuario, usuario, password } = req.body;
    if (!password) return res.status(400).json({ success: false, message: "La contraseña es requerida" });

    db.query('SELECT Contraseña FROM T_Usuario WHERE ID_Usuario = ?', [id_usuario], async (err, results) => {
        if (err) return res.status(500).json({ success: false, message: err.sqlMessage });
        if (results.length === 0) return res.status(404).json({ success: false, message: "Usuario no encontrado" });

        const validPassword = await bcrypt.compare(password, results[0].Contraseña);
        if (!validPassword) return res.status(401).json({ success: false, message: "Contraseña incorrecta" });

        db.query("UPDATE T_Usuario SET Usuario = ? WHERE ID_Usuario = ?", [usuario, id_usuario], (updateErr) => {
            if (updateErr) {
                if (updateErr.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: "Ese nombre de usuario ya está en uso" });
                return res.status(500).json({ success: false, message: updateErr.sqlMessage });
            }
            res.json({ success: true, message: "Perfil actualizado" });
        });
    });
});

app.post('/perfil/foto', upload.single('foto'), (req, res) => {
    const id_usuario = req.body.id_usuario;
    const foto_url = req.file ? `/uploads/${req.file.filename}` : null;
    if (!foto_url) return res.status(400).json({ error: "No se recibió imagen" });
    db.query('UPDATE T_Usuario SET Fotodeperfil_url = ? WHERE ID_Usuario = ?', [foto_url, id_usuario], (err) => {
        if (err) return res.status(500).json({ error: err.sqlMessage });
        res.json({ success: true, foto_url: foto_url });
    });
});

app.get('/estado_verificacion/:id_usuario', (req, res) => {
    const idUsuario = req.params.id_usuario;
    db.query(`SELECT is_verified FROM T_Direccionusuario WHERE ID_Usuario = ?`, [idUsuario], (err, results) => {
        if (err) return res.status(500).json({ error: err.sqlMessage });
        if (results.length === 0) res.json({ estado: 'no_enviado', is_verified: false });
        else if (results[0].is_verified === 0) res.json({ estado: 'en_revision', is_verified: false });
        else res.json({ estado: 'aprobado', is_verified: true });
    });
});

app.post('/verificacion_ine', upload.fields([{ name: 'ine_frontal', maxCount: 1 }, { name: 'ine_trasera', maxCount: 1 }]), async (req, res) => {
    const { id_usuario, calle, num_exterior, num_interior, colonia, codigopostal, ciudad, estado, clave_ine, latitud, longitud } = req.body;
    const ine_frontal = req.files['ine_frontal'] ? req.files['ine_frontal'][0] : null;
    const ine_trasera = req.files['ine_trasera'] ? req.files['ine_trasera'][0] : null;

    if (!ine_frontal || !ine_trasera) return res.status(400).json({ success: false, message: "Debes subir ambas fotos." });

    const frontPath = path.join(__dirname, 'uploads', ine_frontal.filename);
    
    let esValida = 0;
    try {
        console.log("🤖 Iniciando análisis IA de la INE...");
        const result = await Tesseract.recognize(frontPath, 'spa');
        const textoDetectado = result.data.text.toUpperCase();
        
        if (textoDetectado.includes('ELECTORAL') || textoDetectado.includes('CREDENCIAL') || textoDetectado.includes('MEXICO')) {
            esValida = 1; 
            console.log("✅ IA: INE detectada como válida.");
        } else {
            console.log("⚠️ IA: No se detectó texto oficial, enviada a revisión manual.");
        }
    } catch (error) {
        console.error("Error en IA:", error);
    }

    const lat = latitud || 0; 
    const lng = longitud || 0;
    const sql = `INSERT INTO T_Direccionusuario (ID_Usuario, Calle, num_exterior, num_interior, colonia, codigopostal, ciudad, estado, clave_ine, ine_foto_frontal_url, ine_foto_trasera_url, ubicacion_exacta, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?, 4326), ?)`;
    
    const values = [id_usuario, calle, num_exterior, num_interior || null, colonia, codigopostal, ciudad, estado, clave_ine, `/uploads/${ine_frontal.filename}`, `/uploads/${ine_trasera.filename}`, `POINT(${lat} ${lng})`, esValida];

    db.query(sql, values, (err) => {
        if (err) {
            if (err.code === 'ER_DUP_ENTRY') return res.status(400).json({ success: false, message: "Este usuario o INE ya fue registrado." });
            return res.status(500).json({ success: false, message: err.sqlMessage });
        }
        res.status(201).json({ success: true, message: esValida ? '¡Cuenta verificada por IA!' : 'Datos recibidos. Cuenta en revisión manual.' });
    });
});

app.post('/publicaciones', upload.single('foto'), (req, res) => {
    const { id_usuario, tipo_post, descripcion, nombre_mascota, raza, latitud, longitud } = req.body;
    const foto = req.file;
    const sqlPost = `INSERT INTO T_Posts (ID_Usuario, tipo_post, descripcion, nombre_mascota, raza, localizacion) VALUES (?, ?, ?, ?, ?, ST_GeomFromText(?, 4326))`;
    db.query(sqlPost, [id_usuario, tipo_post, descripcion, nombre_mascota, raza, `POINT(${latitud || 0} ${longitud || 0})`], (err, result) => {
        if (err) return res.status(500).json({ error: err.sqlMessage });
        if (foto) db.query(`INSERT INTO T_Imagenesdepost (ID_Post, imagen_url, imagenprimaria) VALUES (?, ?, ?)`, [result.insertId, `/uploads/${foto.filename}`, true]);
        res.status(201).json({ mensaje: 'Publicado' });
    });
});

app.get('/publicaciones', (req, res) => {
    const idUsuario = req.query.id_usuario || 0;
    const tipoFiltro = req.query.tipo;
    const busqueda = req.query.busqueda; 

    let sql = `
        SELECT p.*, ST_X(p.localizacion) AS latitud, ST_Y(p.localizacion) AS longitud,
               u.Nombre AS autor_nombre, u.Fotodeperfil_url, i.imagen_url,
               EXISTS(SELECT 1 FROM T_Postlikes WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_dado_like,
               EXISTS(SELECT 1 FROM T_Postguardados WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_guardado
        FROM T_Posts p
        INNER JOIN T_Usuario u ON p.ID_Usuario = u.ID_Usuario
        LEFT JOIN T_Imagenesdepost i ON p.ID_Post = i.ID_Post AND i.imagenprimaria = 1
        WHERE p.ID_Post NOT IN (SELECT ID_Post FROM T_Postocultados WHERE ID_Usuario = ?)
    `;
    const params = [idUsuario, idUsuario, idUsuario];

    if (tipoFiltro && tipoFiltro !== 'Todos') {
        sql += ` AND p.tipo_post = ?`;
        params.push(tipoFiltro);
    }
    if (busqueda && busqueda.trim() !== '') {
        sql += ` AND (p.nombre_mascota LIKE ? OR p.raza LIKE ? OR p.descripcion LIKE ?)`;
        params.push(`%${busqueda}%`, `%${busqueda}%`, `%${busqueda}%`);
    }
    sql += ` ORDER BY p.fechadepublicacion DESC`;

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ error: err.sqlMessage });
        res.json(results);
    });
});

app.get('/mis_publicaciones/:id', (req, res) => {
    const idUsuario = req.params.id;
    const sql = `SELECT p.*, ST_X(p.localizacion) AS latitud, ST_Y(p.localizacion) AS longitud, u.Nombre AS autor_nombre, u.Fotodeperfil_url, i.imagen_url, EXISTS(SELECT 1 FROM T_Postlikes WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_dado_like, EXISTS(SELECT 1 FROM T_Postguardados WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_guardado FROM T_Posts p INNER JOIN T_Usuario u ON p.ID_Usuario = u.ID_Usuario LEFT JOIN T_Imagenesdepost i ON p.ID_Post = i.ID_Post AND i.imagenprimaria = 1 WHERE p.ID_Usuario = ? ORDER BY p.fechadepublicacion DESC`;
    db.query(sql, [idUsuario, idUsuario, idUsuario], (err, results) => res.json(results));
});

app.get('/publicaciones_guardadas/:id', (req, res) => {
    const idUsuario = req.params.id;
    const sql = `SELECT p.*, ST_X(p.localizacion) AS latitud, ST_Y(p.localizacion) AS longitud, u.Nombre AS autor_nombre, u.Fotodeperfil_url, i.imagen_url, EXISTS(SELECT 1 FROM T_Postlikes WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_dado_like, 1 AS ha_guardado FROM T_Postguardados g INNER JOIN T_Posts p ON g.ID_Post = p.ID_Post INNER JOIN T_Usuario u ON p.ID_Usuario = u.ID_Usuario LEFT JOIN T_Imagenesdepost i ON p.ID_Post = i.ID_Post AND i.imagenprimaria = 1 WHERE g.ID_Usuario = ? ORDER BY g.saved_at DESC`;
    db.query(sql, [idUsuario, idUsuario], (err, results) => res.json(results));
});

app.delete('/publicaciones/:id', (req, res) => {
    db.query('DELETE FROM T_Posts WHERE ID_Post = ?', [req.params.id], (err) => res.json({ success: true }));
});

app.put('/publicaciones/:id/estado', (req, res) => {
    db.query('UPDATE T_Posts SET estado = ? WHERE ID_Post = ?', [req.body.estado, req.params.id], (err) => res.json({ success: true }));
});

app.put('/publicaciones/:id', (req, res) => {
    const { tipo_post, descripcion, nombre_mascota, raza } = req.body;
    db.query('UPDATE T_Posts SET tipo_post = ?, descripcion = ?, nombre_mascota = ?, raza = ? WHERE ID_Post = ?', [tipo_post, descripcion, nombre_mascota, raza, req.params.id], (err) => res.json({ success: true }));
});

app.post('/like', (req, res) => {
    const { id_usuario, id_post } = req.body;
    db.query('SELECT * FROM T_Postlikes WHERE ID_Usuario = ? AND ID_Post = ?', [id_usuario, id_post], (err, results) => {
        if (results.length > 0) {
            db.query('DELETE FROM T_Postlikes WHERE ID_Usuario = ? AND ID_Post = ?', [id_usuario, id_post], () => {
                db.query('UPDATE T_Posts SET cant_likes = GREATEST(0, cant_likes - 1) WHERE ID_Post = ?', [id_post]);
                res.json({ liked: false });
            });
        } else {
            db.query('INSERT INTO T_Postlikes (ID_Usuario, ID_Post) VALUES (?, ?)', [id_usuario, id_post], () => {
                db.query('UPDATE T_Posts SET cant_likes = cant_likes + 1 WHERE ID_Post = ?', [id_post]);
                res.json({ liked: true });
            });
        }
    });
});

app.post('/guardar_post', (req, res) => {
    const { id_usuario, id_post } = req.body;
    db.query('SELECT * FROM T_Postguardados WHERE ID_Usuario = ? AND ID_Post = ?', [id_usuario, id_post], (err, results) => {
        if (results.length > 0) {
            db.query('DELETE FROM T_Postguardados WHERE ID_Usuario = ? AND ID_Post = ?', [id_usuario, id_post], () => res.json({ saved: false }));
        } else {
            db.query('INSERT INTO T_Postguardados (ID_Usuario, ID_Post) VALUES (?, ?)', [id_usuario, id_post], () => res.json({ saved: true }));
        }
    });
});

app.post('/ocultar_post', (req, res) => {
    const { id_usuario, id_post } = req.body;
    db.query('INSERT IGNORE INTO T_Postocultados (ID_Usuario, ID_Post) VALUES (?, ?)', [id_usuario, id_post], (err) => res.json({ success: true }));
});

app.get('/comentarios/:id_post', (req, res) => {
    const idUsuario = req.query.id_usuario || 0;
    const sql = `SELECT c.*, u.Nombre, u.Fotodeperfil_url, EXISTS(SELECT 1 FROM T_Likesdecomentarios WHERE ID_Comentario = c.ID_Comentario AND ID_Usuario = ?) AS ha_dado_like FROM T_Comentarios c JOIN T_Usuario u ON c.ID_Usuario = u.ID_Usuario WHERE c.ID_Post = ? ORDER BY c.fecha DESC`;
    db.query(sql, [idUsuario, req.params.id_post], (err, results) => res.json(results));
});

app.post('/comentarios', (req, res) => {
    const { id_usuario, id_post, comentario } = req.body;
    db.query('INSERT INTO T_Comentarios (ID_Usuario, ID_Post, Comentario) VALUES (?, ?, ?)', [id_usuario, id_post, comentario], (err) => {
        db.query('UPDATE T_Posts SET cant_comentarios = cant_comentarios + 1 WHERE ID_Post = ?', [id_post], () => res.json({ success: true }));
    });
});

app.post('/like_comentario', (req, res) => {
    const { id_usuario, id_comentario } = req.body;
    db.query('SELECT * FROM T_Likesdecomentarios WHERE ID_Usuario = ? AND ID_Comentario = ?', [id_usuario, id_comentario], (err, results) => {
        if (results.length > 0) {
            db.query('DELETE FROM T_Likesdecomentarios WHERE ID_Usuario = ? AND ID_Comentario = ?', [id_usuario, id_comentario], () => {
                db.query('UPDATE T_Comentarios SET likes = GREATEST(0, likes - 1) WHERE ID_Comentario = ?', [id_comentario]);
                res.json({ liked: false });
            });
        } else {
            db.query('INSERT INTO T_Likesdecomentarios (ID_Usuario, ID_Comentario) VALUES (?, ?)', [id_usuario, id_comentario], () => {
                db.query('UPDATE T_Comentarios SET likes = likes + 1 WHERE ID_Comentario = ?', [id_comentario]);
                res.json({ liked: true });
            });
        }
    });
});

app.post('/reportes', (req, res) => {
    const { id_usuario, id_post, id_comentario, reason, descripcion } = req.body;
    const postID = id_post ? id_post : null;
    const comentarioID = id_comentario ? id_comentario : null;
    db.query(`INSERT INTO T_Reportes (ID_Usuario, ID_Post, ID_Comentario, reason, descripcion) VALUES (?, ?, ?, ?, ?)`, [id_usuario, postID, comentarioID, reason, descripcion], (err) => res.json({ success: true }));
});

app.post('/mensajes', (req, res) => {
    const { id_remitente, id_destinatario, contenido } = req.body;
    db.query(`SELECT ID_Chat FROM T_Chats WHERE (ID_Usuario1 = ? AND ID_Usuario2 = ?) OR (ID_Usuario1 = ? AND ID_Usuario2 = ?)`, [id_remitente, id_destinatario, id_destinatario, id_remitente], (err, results) => {
        const insertMsg = (chatId) => db.query(`INSERT INTO T_Mensajes (ID_Chat, ID_Usuario, contenido) VALUES (?, ?, ?)`, [chatId, id_remitente, contenido], () => res.json({ success: true }));
        if (results.length > 0) insertMsg(results[0].ID_Chat);
        else db.query(`INSERT INTO T_Chats (ID_Usuario1, ID_Usuario2) VALUES (?, ?)`, [id_remitente, id_destinatario], (err3, newChat) => insertMsg(newChat.insertId));
    });
});

app.post('/mensajes_imagen', upload.single('archivo'), (req, res) => {
    const { id_remitente, id_destinatario } = req.body;
    const archivo_url = req.file ? `/uploads/${req.file.filename}` : null;
    db.query(`SELECT ID_Chat FROM T_Chats WHERE (ID_Usuario1 = ? AND ID_Usuario2 = ?) OR (ID_Usuario1 = ? AND ID_Usuario2 = ?)`, [id_remitente, id_destinatario, id_destinatario, id_remitente], (err, results) => {
        const insertMsg = (chatId) => db.query(`INSERT INTO T_Mensajes (ID_Chat, ID_Usuario, archivo_url, tipo_archivo) VALUES (?, ?, ?, 'imagen')`, [chatId, id_remitente, archivo_url], () => res.json({ success: true }));
        if (results.length > 0) insertMsg(results[0].ID_Chat);
        else db.query(`INSERT INTO T_Chats (ID_Usuario1, ID_Usuario2) VALUES (?, ?)`, [id_remitente, id_destinatario], (err3, newChat) => insertMsg(newChat.insertId));
    });
});

app.get('/mensajes/:contacto_id', (req, res) => {
    const mi_id = req.query.mi_id;
    const contacto_id = req.params.contacto_id;
    db.query(`SELECT m.* FROM T_Mensajes m JOIN T_Chats c ON m.ID_Chat = c.ID_Chat WHERE (c.ID_Usuario1 = ? AND c.ID_Usuario2 = ?) OR (c.ID_Usuario1 = ? AND c.ID_Usuario2 = ?) ORDER BY m.fechadeenvio ASC`, [mi_id, contacto_id, contacto_id, mi_id], (err, results) => res.json(results));
});

app.put('/mensajes/leer', (req, res) => {
    const { mi_id, contacto_id } = req.body;
    db.query(`UPDATE T_Mensajes SET leido = TRUE WHERE ID_Usuario = ? AND ID_Chat IN (SELECT ID_Chat FROM T_Chats WHERE (ID_Usuario1 = ? AND ID_Usuario2 = ?) OR (ID_Usuario1 = ? AND ID_Usuario2 = ?))`, [contacto_id, mi_id, contacto_id, contacto_id, mi_id], (err) => res.json({ success: true }));
});

app.get('/chats_activos', (req, res) => {
    const mi_id = req.query.mi_id;
    db.query(`SELECT c.ID_Chat, u.ID_Usuario AS contacto_id, u.Nombre AS contacto_nombre, m.contenido AS ultimo_mensaje, m.archivo_url, m.fechadeenvio, (SELECT COUNT(*) FROM T_Mensajes m2 WHERE m2.ID_Chat = c.ID_Chat AND m2.ID_Usuario = u.ID_Usuario AND m2.leido = FALSE) AS mensajes_sin_leer FROM T_Chats c JOIN T_Usuario u ON (u.ID_Usuario = c.ID_Usuario1 OR u.ID_Usuario = c.ID_Usuario2) AND u.ID_Usuario != ? LEFT JOIN T_Mensajes m ON m.ID_Mensajes = (SELECT MAX(ID_Mensajes) FROM T_Mensajes WHERE ID_Chat = c.ID_Chat) WHERE (c.ID_Usuario1 = ? OR c.ID_Usuario2 = ?) AND m.ID_Mensajes IS NOT NULL ORDER BY m.fechadeenvio DESC`, [mi_id, mi_id, mi_id], (err, results) => res.json(results));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Backend PetHome corriendo en puerto ${PORT}`));
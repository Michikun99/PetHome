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
        console.log('✅ PetHome Conectado a Railway (Pool Seguro)');
        
        // Creamos la tabla si no existe
        connection.query(`
            CREATE TABLE IF NOT EXISTS T_Notificaciones (
                ID_Notificacion INT AUTO_INCREMENT PRIMARY KEY,
                ID_Usuario INT NOT NULL,
                tipo VARCHAR(50), 
                mensaje VARCHAR(255),
                ID_Referencia INT, 
                leido BOOLEAN DEFAULT FALSE,
                fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `, (err) => {
            if(!err) {
                // Actualizamos la tabla si ya existía para agregarle la columna ID_Referencia
                connection.query(`ALTER TABLE T_Notificaciones ADD COLUMN ID_Referencia INT`, (alterErr) => {
                    // Ignoramos el error si la columna ya existe
                    console.log("✅ Tabla de Notificaciones lista y actualizada.");
                });
            }
        });
        connection.release();
    }
});

const SECRET_KEY = "pethome_clave_super_secreta";

// ==========================================
// SESIÓN, REGISTRO Y PERFIL
// ==========================================
app.post('/register', async (req, res) => {
    const { usuario, nombre, correo, password, telefono } = req.body;
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const sql = `INSERT INTO T_Usuario (Usuario, Nombre, Correo, Contraseña, Telefono) VALUES (?, ?, ?, ?, ?)`;
        db.query(sql, [usuario, nombre, correo, hashedPassword, telefono], (err) => {
            if (err) return res.status(400).json({ mensaje: 'Error al registrar', detalle: err.sqlMessage });
            res.status(201).json({ mensaje: 'Registrado' });
        });
    } catch (e) { res.status(500).json({ mensaje: 'Error interno' }); }
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
    db.query('SELECT Contraseña FROM T_Usuario WHERE ID_Usuario = ?', [id_usuario], async (err, results) => {
        const validPassword = await bcrypt.compare(password, results[0].Contraseña);
        if (!validPassword) return res.status(401).json({ success: false, message: "Contraseña incorrecta" });
        db.query("UPDATE T_Usuario SET Usuario = ? WHERE ID_Usuario = ?", [usuario, id_usuario], (updateErr) => {
            res.json({ success: true, message: "Perfil actualizado" });
        });
    });
});

app.post('/perfil/foto', upload.single('foto'), (req, res) => {
    const foto_url = req.file ? `/uploads/${req.file.filename}` : null;
    db.query('UPDATE T_Usuario SET Fotodeperfil_url = ? WHERE ID_Usuario = ?', [foto_url, req.body.id_usuario], (err) => {
        res.json({ success: true, foto_url: foto_url });
    });
});

// ==========================================
// VERIFICACIÓN IA
// ==========================================
app.get('/estado_verificacion/:id_usuario', (req, res) => {
    db.query(`SELECT is_verified FROM T_Direccionusuario WHERE ID_Usuario = ?`, [req.params.id_usuario], (err, results) => {
        if (results.length === 0) res.json({ estado: 'no_enviado', is_verified: false });
        else if (results[0].is_verified === 0) res.json({ estado: 'en_revision', is_verified: false });
        else res.json({ estado: 'aprobado', is_verified: true });
    });
});

app.post('/verificacion_ine', upload.fields([{ name: 'ine_frontal', maxCount: 1 }, { name: 'ine_trasera', maxCount: 1 }]), async (req, res) => {
    const { id_usuario, calle, num_exterior, num_interior, colonia, codigopostal, ciudad, estado, clave_ine, latitud, longitud } = req.body;
    const lat = latitud || 0; const lng = longitud || 0;
    const sql = `INSERT INTO T_Direccionusuario (ID_Usuario, Calle, num_exterior, num_interior, colonia, codigopostal, ciudad, estado, clave_ine, ine_foto_frontal_url, ine_foto_trasera_url, ubicacion_exacta, is_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ST_GeomFromText(?, 4326), ?)`;
    db.query(sql, [id_usuario, calle, num_exterior, num_interior || null, colonia, codigopostal, ciudad, estado, clave_ine, 'url1', 'url2', `POINT(${lat} ${lng})`, 1], (err) => res.status(201).json({ success: true }));
});

// ==========================================
// PUBLICACIONES Y NUEVO ENDPOINT (POST ÚNICO)
// ==========================================
app.post('/publicaciones', upload.single('foto'), (req, res) => {
    const { id_usuario, tipo_post, descripcion, nombre_mascota, raza, latitud, longitud } = req.body;
    const foto = req.file; const lat = latitud || 0; const lng = longitud || 0;
    const sqlPost = `INSERT INTO T_Posts (ID_Usuario, tipo_post, descripcion, nombre_mascota, raza, localizacion) VALUES (?, ?, ?, ?, ?, ST_GeomFromText(?, 4326))`;
    db.query(sqlPost, [id_usuario, tipo_post, descripcion, nombre_mascota, raza, `POINT(${lat} ${lng})`], (err, result) => {
        if (err) return res.status(500).json({ error: err.sqlMessage });
        if (foto) db.query(`INSERT INTO T_Imagenesdepost (ID_Post, imagen_url, imagenprimaria) VALUES (?, ?, ?)`, [result.insertId, `/uploads/${foto.filename}`, true]);
        
        // ✨ NOTIFICAR MASCOTA CERCA CON ID_REFERENCIA ✨
        if (lat != 0 && lng != 0) {
            const sqlCerca = `
                INSERT INTO T_Notificaciones (ID_Usuario, tipo, mensaje, ID_Referencia)
                SELECT ID_Usuario, 'cerca', CONCAT('¡Un caso de mascota ', ?, ' cerca de ti!'), ?
                FROM T_Direccionusuario
                WHERE ID_Usuario != ? AND ST_Distance_Sphere(ubicacion_exacta, ST_GeomFromText(?, 4326)) <= 5000
            `;
            db.query(sqlCerca, [tipo_post, result.insertId, id_usuario]);
        }
        res.status(201).json({ mensaje: 'Publicado' });
    });
});

app.get('/publicaciones', (req, res) => {
    const idUsuario = req.query.id_usuario || 0;
    const { tipo, busqueda } = req.query;
    let sql = `SELECT p.*, ST_X(p.localizacion) AS latitud, ST_Y(p.localizacion) AS longitud, u.Nombre AS autor_nombre, u.Fotodeperfil_url, i.imagen_url, EXISTS(SELECT 1 FROM T_Postlikes WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_dado_like, EXISTS(SELECT 1 FROM T_Postguardados WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_guardado FROM T_Posts p INNER JOIN T_Usuario u ON p.ID_Usuario = u.ID_Usuario LEFT JOIN T_Imagenesdepost i ON p.ID_Post = i.ID_Post AND i.imagenprimaria = 1 WHERE p.ID_Post NOT IN (SELECT ID_Post FROM T_Postocultados WHERE ID_Usuario = ?)`;
    const params = [idUsuario, idUsuario, idUsuario];
    if (tipo && tipo !== 'Todos') { sql += ` AND p.tipo_post = ?`; params.push(tipo); }
    if (busqueda) { sql += ` AND (p.nombre_mascota LIKE ? OR p.descripcion LIKE ?)`; params.push(`%${busqueda}%`, `%${busqueda}%`); }
    sql += ` ORDER BY p.fechadepublicacion DESC`;
    db.query(sql, params, (err, results) => res.json(results || []));
});

// ✨ NUEVO ENDPOINT: Buscar un solo Post por su ID para poder abrirlo desde la alerta
app.get('/publicacion/:id', (req, res) => {
    const idPost = req.params.id;
    const idUsuario = req.query.id_usuario || 0;
    let sql = `
        SELECT p.*, ST_X(p.localizacion) AS latitud, ST_Y(p.localizacion) AS longitud,
               u.Nombre AS autor_nombre, u.Fotodeperfil_url, i.imagen_url,
               EXISTS(SELECT 1 FROM T_Postlikes WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_dado_like,
               EXISTS(SELECT 1 FROM T_Postguardados WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_guardado
        FROM T_Posts p
        INNER JOIN T_Usuario u ON p.ID_Usuario = u.ID_Usuario
        LEFT JOIN T_Imagenesdepost i ON p.ID_Post = i.ID_Post AND i.imagenprimaria = 1
        WHERE p.ID_Post = ?
    `;
    db.query(sql, [idUsuario, idUsuario, idPost], (err, results) => {
        if (err || results.length === 0) return res.status(404).json(null);
        res.json(results[0]);
    });
});

app.get('/mis_publicaciones/:id', (req, res) => {
    const idUsuario = req.params.id;
    const sql = `SELECT p.*, ST_X(p.localizacion) AS latitud, ST_Y(p.localizacion) AS longitud, u.Nombre AS autor_nombre, u.Fotodeperfil_url, i.imagen_url, EXISTS(SELECT 1 FROM T_Postlikes WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_dado_like, EXISTS(SELECT 1 FROM T_Postguardados WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_guardado FROM T_Posts p INNER JOIN T_Usuario u ON p.ID_Usuario = u.ID_Usuario LEFT JOIN T_Imagenesdepost i ON p.ID_Post = i.ID_Post AND i.imagenprimaria = 1 WHERE p.ID_Usuario = ? ORDER BY p.fechadepublicacion DESC`;
    db.query(sql, [idUsuario, idUsuario, idUsuario], (err, results) => res.json(results || []));
});

app.get('/publicaciones_guardadas/:id', (req, res) => {
    const idUsuario = req.params.id;
    const sql = `SELECT p.*, ST_X(p.localizacion) AS latitud, ST_Y(p.localizacion) AS longitud, u.Nombre AS autor_nombre, u.Fotodeperfil_url, i.imagen_url, EXISTS(SELECT 1 FROM T_Postlikes WHERE ID_Post = p.ID_Post AND ID_Usuario = ?) AS ha_dado_like, 1 AS ha_guardado FROM T_Postguardados g INNER JOIN T_Posts p ON g.ID_Post = p.ID_Post INNER JOIN T_Usuario u ON p.ID_Usuario = u.ID_Usuario LEFT JOIN T_Imagenesdepost i ON p.ID_Post = i.ID_Post AND i.imagenprimaria = 1 WHERE g.ID_Usuario = ? ORDER BY g.saved_at DESC`;
    db.query(sql, [idUsuario, idUsuario], (err, results) => res.json(results || []));
});

app.delete('/publicaciones/:id', (req, res) => db.query('DELETE FROM T_Posts WHERE ID_Post = ?', [req.params.id], () => res.json({ success: true })));
app.put('/publicaciones/:id/estado', (req, res) => db.query('UPDATE T_Posts SET estado = ? WHERE ID_Post = ?', [req.body.estado, req.params.id], () => res.json({ success: true })));
app.put('/publicaciones/:id', (req, res) => db.query('UPDATE T_Posts SET tipo_post=?, descripcion=?, nombre_mascota=?, raza=? WHERE ID_Post=?', [req.body.tipo_post, req.body.descripcion, req.body.nombre_mascota, req.body.raza, req.params.id], () => res.json({ success: true })));

// ==========================================
// INTERACCIONES Y LIKES (CON NOMBRE E ID)
// ==========================================
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
                
                // ✨ AVISAR CON NOMBRE DEL USUARIO Y REFERENCIA AL POST
                db.query(`
                    INSERT INTO T_Notificaciones (ID_Usuario, tipo, mensaje, ID_Referencia) 
                    SELECT p.ID_Usuario, 'like', CONCAT((SELECT Nombre FROM T_Usuario WHERE ID_Usuario = ?), ' le dio like a tu publicación'), ? 
                    FROM T_Posts p WHERE p.ID_Post = ? AND p.ID_Usuario != ?
                `, [id_usuario, id_post, id_post, id_usuario]);

                res.json({ liked: true });
            });
        }
    });
});

app.post('/guardar_post', (req, res) => {
    const { id_usuario, id_post } = req.body;
    db.query('SELECT * FROM T_Postguardados WHERE ID_Usuario = ? AND ID_Post = ?', [id_usuario, id_post], (err, results) => {
        if (results.length > 0) db.query('DELETE FROM T_Postguardados WHERE ID_Usuario = ? AND ID_Post = ?', [id_usuario, id_post], () => res.json({ saved: false }));
        else db.query('INSERT INTO T_Postguardados (ID_Usuario, ID_Post) VALUES (?, ?)', [id_usuario, id_post], () => res.json({ saved: true }));
    });
});

app.post('/ocultar_post', (req, res) => db.query('INSERT IGNORE INTO T_Postocultados (ID_Usuario, ID_Post) VALUES (?, ?)', [req.body.id_usuario, req.body.id_post], () => res.json({ success: true })));

// ==========================================
// COMENTARIOS (CON NOMBRE E ID)
// ==========================================
app.get('/comentarios/:id_post', (req, res) => {
    const sql = `SELECT c.*, u.Nombre, u.Fotodeperfil_url, EXISTS(SELECT 1 FROM T_Likesdecomentarios WHERE ID_Comentario = c.ID_Comentario AND ID_Usuario = ?) AS ha_dado_like FROM T_Comentarios c JOIN T_Usuario u ON c.ID_Usuario = u.ID_Usuario WHERE c.ID_Post = ? ORDER BY c.fecha DESC`;
    db.query(sql, [req.query.id_usuario || 0, req.params.id_post], (err, results) => res.json(results || []));
});

app.post('/comentarios', (req, res) => {
    const { id_usuario, id_post, comentario } = req.body;
    db.query('INSERT INTO T_Comentarios (ID_Usuario, ID_Post, Comentario) VALUES (?, ?, ?)', [id_usuario, id_post, comentario], (err) => {
        db.query('UPDATE T_Posts SET cant_comentarios = cant_comentarios + 1 WHERE ID_Post = ?', [id_post], () => {
            
            // ✨ AVISAR CON NOMBRE DEL USUARIO Y REFERENCIA AL POST
            db.query(`
                INSERT INTO T_Notificaciones (ID_Usuario, tipo, mensaje, ID_Referencia) 
                SELECT p.ID_Usuario, 'comentario', CONCAT((SELECT Nombre FROM T_Usuario WHERE ID_Usuario = ?), ' comentó tu publicación'), ? 
                FROM T_Posts p WHERE p.ID_Post = ? AND p.ID_Usuario != ?
            `, [id_usuario, id_post, id_post, id_usuario]);

            res.json({ success: true });
        });
    });
});

app.post('/like_comentario', (req, res) => {
    const { id_usuario, id_comentario } = req.body;
    db.query('SELECT * FROM T_Likesdecomentarios WHERE ID_Usuario = ? AND ID_Comentario = ?', [id_usuario, id_comentario], (err, results) => {
        if (results.length > 0) {
            db.query('DELETE FROM T_Likesdecomentarios WHERE ID_Usuario = ? AND ID_Comentario = ?', [id_usuario, id_comentario], () => {
                db.query('UPDATE T_Comentarios SET likes = GREATEST(0, likes - 1) WHERE ID_Comentario = ?', [id_comentario]); res.json({ liked: false });
            });
        } else {
            db.query('INSERT INTO T_Likesdecomentarios (ID_Usuario, ID_Comentario) VALUES (?, ?)', [id_usuario, id_comentario], () => {
                db.query('UPDATE T_Comentarios SET likes = likes + 1 WHERE ID_Comentario = ?', [id_comentario]); res.json({ liked: true });
            });
        }
    });
});

app.post('/reportes', (req, res) => {
    const { id_usuario, id_post, id_comentario, reason, descripcion } = req.body;
    db.query(`INSERT INTO T_Reportes (ID_Usuario, ID_Post, ID_Comentario, reason, descripcion) VALUES (?, ?, ?, ?, ?)`, [id_usuario, id_post || null, id_comentario || null, reason, descripcion], () => res.json({ success: true }));
});

// ==========================================
// MENSAJES DIRECTOS (CON NOMBRE E ID REMITENTE)
// ==========================================
app.post('/mensajes', (req, res) => {
    const { id_remitente, id_destinatario, contenido } = req.body;
    db.query(`SELECT ID_Chat FROM T_Chats WHERE (ID_Usuario1 = ? AND ID_Usuario2 = ?) OR (ID_Usuario1 = ? AND ID_Usuario2 = ?)`, [id_remitente, id_destinatario, id_destinatario, id_remitente], (err, results) => {
        const insertMsg = (chatId) => {
            db.query(`INSERT INTO T_Mensajes (ID_Chat, ID_Usuario, contenido) VALUES (?, ?, ?)`, [chatId, id_remitente, contenido], () => {
                
                // ✨ AVISAR CON NOMBRE Y REFERENCIA AL ID DEL CHAT/REMITENTE
                db.query(`
                    INSERT INTO T_Notificaciones (ID_Usuario, tipo, mensaje, ID_Referencia) 
                    VALUES (?, 'mensaje', CONCAT((SELECT Nombre FROM T_Usuario WHERE ID_Usuario = ?), ' te ha enviado un mensaje'), ?)
                `, [id_destinatario, id_remitente, id_remitente]);

                res.json({ success: true });
            });
        };
        if (results.length > 0) insertMsg(results[0].ID_Chat);
        else db.query(`INSERT INTO T_Chats (ID_Usuario1, ID_Usuario2) VALUES (?, ?)`, [id_remitente, id_destinatario], (err3, newChat) => insertMsg(newChat.insertId));
    });
});

app.post('/mensajes_imagen', upload.single('archivo'), (req, res) => {
    const { id_remitente, id_destinatario } = req.body;
    const archivo_url = req.file ? `/uploads/${req.file.filename}` : null;
    db.query(`SELECT ID_Chat FROM T_Chats WHERE (ID_Usuario1 = ? AND ID_Usuario2 = ?) OR (ID_Usuario1 = ? AND ID_Usuario2 = ?)`, [id_remitente, id_destinatario, id_destinatario, id_remitente], (err, results) => {
        const insertMsg = (chatId) => {
            db.query(`INSERT INTO T_Mensajes (ID_Chat, ID_Usuario, archivo_url, tipo_archivo) VALUES (?, ?, ?, 'imagen')`, [chatId, id_remitente, archivo_url], () => {
                
                db.query(`
                    INSERT INTO T_Notificaciones (ID_Usuario, tipo, mensaje, ID_Referencia) 
                    VALUES (?, 'mensaje', CONCAT((SELECT Nombre FROM T_Usuario WHERE ID_Usuario = ?), ' te ha enviado una foto'), ?)
                `, [id_destinatario, id_remitente, id_remitente]);

                res.json({ success: true });
            });
        };
        if (results.length > 0) insertMsg(results[0].ID_Chat);
        else db.query(`INSERT INTO T_Chats (ID_Usuario1, ID_Usuario2) VALUES (?, ?)`, [id_remitente, id_destinatario], (err3, newChat) => insertMsg(newChat.insertId));
    });
});

app.get('/mensajes/:contacto_id', (req, res) => {
    const mi_id = req.query.mi_id;
    const contacto_id = req.params.contacto_id;
    db.query(`SELECT m.* FROM T_Mensajes m JOIN T_Chats c ON m.ID_Chat = c.ID_Chat WHERE (c.ID_Usuario1 = ? AND c.ID_Usuario2 = ?) OR (c.ID_Usuario1 = ? AND c.ID_Usuario2 = ?) ORDER BY m.fechadeenvio ASC`, [mi_id, contacto_id, contacto_id, mi_id], (err, results) => res.json(results || []));
});

app.put('/mensajes/leer', (req, res) => {
    const { mi_id, contacto_id } = req.body;
    db.query(`UPDATE T_Mensajes SET leido = TRUE WHERE ID_Usuario = ? AND ID_Chat IN (SELECT ID_Chat FROM T_Chats WHERE (ID_Usuario1 = ? AND ID_Usuario2 = ?) OR (ID_Usuario1 = ? AND ID_Usuario2 = ?))`, [contacto_id, mi_id, contacto_id, contacto_id, mi_id], (err) => res.json({ success: true }));
});

// ==========================================
// CHATS ACTIVOS (CON ESTADO DE VISTO Y FOTO DE PERFIL)
// ==========================================
app.get('/chats_activos', (req, res) => {
    const mi_id = req.query.mi_id;
    const sql = `
        SELECT c.ID_Chat, u.ID_Usuario AS contacto_id, u.Nombre AS contacto_nombre, u.Fotodeperfil_url AS contacto_foto,
               m.contenido AS ultimo_mensaje, m.archivo_url, m.fechadeenvio,
               m.ID_Usuario AS ultimo_mensaje_remitente,
               m.leido AS ultimo_mensaje_leido,
               (SELECT COUNT(*) FROM T_Mensajes m2 WHERE m2.ID_Chat = c.ID_Chat AND m2.ID_Usuario = u.ID_Usuario AND m2.leido = FALSE) AS mensajes_sin_leer 
        FROM T_Chats c 
        JOIN T_Usuario u ON (u.ID_Usuario = c.ID_Usuario1 OR u.ID_Usuario = c.ID_Usuario2) AND u.ID_Usuario != ? 
        LEFT JOIN T_Mensajes m ON m.ID_Mensajes = (SELECT MAX(ID_Mensajes) FROM T_Mensajes WHERE ID_Chat = c.ID_Chat) 
        WHERE (c.ID_Usuario1 = ? OR c.ID_Usuario2 = ?) AND m.ID_Mensajes IS NOT NULL 
        ORDER BY m.fechadeenvio DESC
    `;
    db.query(sql, [mi_id, mi_id, mi_id], (err, results) => res.json(results || []));
});

// ==========================================
// NOTIFICACIONES
// ==========================================
app.get('/notificaciones/:id_usuario', (req, res) => {
    const idUsuario = req.params.id_usuario;
    db.query(`SELECT * FROM T_Notificaciones WHERE ID_Usuario = ? ORDER BY fecha DESC LIMIT 50`, [idUsuario], (err, results) => res.json(results || []));
});

app.put('/notificaciones/leer/:id_usuario', (req, res) => {
    const idUsuario = req.params.id_usuario;
    db.query(`UPDATE T_Notificaciones SET leido = TRUE WHERE ID_Usuario = ?`, [idUsuario], (err) => res.json({ success: true }));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Backend PetHome corriendo en puerto ${PORT}`));
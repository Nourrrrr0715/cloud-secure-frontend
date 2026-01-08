require('dotenv').config();
const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const session = require('express-session');
const { Client } = require('ssh2');

const app = express();
const PORT = 5001;
let pipelineLogs = [];

// Configuration CORS pour accepter les requêtes depuis le navigateur et le conteneur frontend
app.use(cors({ 
    origin: [
        'http://localhost:3000', 
        'http://127.0.0.1:3000', 
        'http://192.168.20.128:3000',
        'http://frontend:3000'
    ],
    credentials: true 
}));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_temporaire',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new GitHubStrategy({
    clientID: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackURL: `http://localhost:${PORT}/auth/github/callback`
}, (at, rt, profile, done) => done(null, profile)));

// --- pipeline logique métier ---
const runFullPipeline = () => {
    pipelineLogs = [];
    const log = (msg) => {
        const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        pipelineLogs.push(entry);
        console.log(entry);
    };

    return new Promise((resolve, reject) => {
        const workspace = path.join(__dirname, 'workspace');
        const projectPath = path.join(workspace, 'app-metier');

        // Configuration des deux services
        const services = [
            {
                name: 'frontend',
                image: 'app-pcs-front:latest',
                container: 'app-pcs-front-cont',
                port: '3000:80',  // Nginx écoute sur 80 dans le conteneur
                path: path.join(projectPath, 'frontend')
            },
            {
                name: 'backend',
                image: 'app-pcs-back:latest',
                container: 'app-pcs-back-cont',
                port: '8080:8080',
                path: path.join(projectPath, 'backend')
            }
        ];

        log("🚀 Démarrage du Pipeline Full-Stack (Front + Back)...");
        log(`📂 Chemin du projet : ${projectPath}`);

        // 1. Git Pull
        const fetchCmd = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone https://github.com/ML-Laurane/Appli-PCS.git ${projectPath}`;
        log(`🔧 Commande Git : ${fetchCmd}`);
        log("⏳ Récupération du code source...");

        exec(fetchCmd, async (err, stdout, stderr) => {
            if (err) {
                log(`❌ Erreur Git: ${err.message}`);
                if (stderr) log(`Git stderr: ${stderr}`);
                return reject("Erreur Git: " + err.message);
            }
            if (stdout) log(`Git output: ${stdout.trim()}`);
            log("✅ Code source mis à jour.");

            try {
                log(`🔑 Tentative de connexion SSH à ${process.env.VM_IP || '192.168.20.128'}:22...`);
                const conn = new Client();
                
                conn.on('error', (err) => {
                    log(`❌ Erreur SSH: ${err.message}`);
                });

                conn.on('ready', async () => {
                    log("📡 Connexion SSH établie avec la VM.");

                    for (const service of services) {
                        log(`\n--- 🚢 Service : ${service.name.toUpperCase()} ---`);
                        const tarPath = path.join(workspace, `${service.name}.tar`);
                        log(`📁 Chemin de l'image : ${service.path}`);
                        log(`💾 Archive : ${tarPath}`);

                        // 2. Build local
                        log(`🔨 Début du build de l'image ${service.image}...`);
                        await new Promise((res, rej) => {
                            exec(`docker build -t ${service.image} ${service.path}`, (e, stdout, stderr) => {
                                if (e) {
                                    log(`❌ Erreur build: ${e.message}`);
                                    if (stderr) log(`Build stderr: ${stderr}`);
                                    return rej(e);
                                }
                                log(`✅ Build terminé pour ${service.image}`);
                                res();
                            });
                        });

                        // 3. Export .tar
                        log(`📦 Création de l'archive ${service.name}.tar...`);
                        await new Promise((res, rej) => {
                            exec(`docker save ${service.image} -o ${tarPath}`, (e) => {
                                if (e) {
                                    log(`❌ Erreur export: ${e.message}`);
                                    return rej(e);
                                }
                                const stats = fs.statSync(tarPath);
                                log(`✅ Archive créée (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                                res();
                            });
                        });

                        // 4. Nettoyage VM pour ce port précis
                        log(`🧹 Nettoyage des anciens conteneurs sur le port ${service.port.split(':')[0]}...`);
                        await new Promise((res) => {
                            const cleanCmd = `ids=$(docker ps -q --filter "publish=${service.port.split(':')[0]}"); if [ ! -z "$ids" ]; then docker stop $ids && docker rm $ids; fi; exit`;
                            conn.exec(cleanCmd, (e, stream) => {
                                if (e) log(`⚠️ Erreur lors du nettoyage: ${e.message}`);
                                stream.on('data', (data) => log(`VM clean: ${data.toString().trim()}`));
                                stream.on('end', () => {
                                    log(`✅ Nettoyage terminé`);
                                    res();
                                });
                                stream.resume();
                            });
                        });

                        // 5. Transfert et Load
                        log(`📤 Début du transfert de l'image ${service.name} vers la VM...`);
                        let bytesTransferred = 0;
                        await new Promise((res, rej) => {
                            conn.exec('docker load', (e, stream) => {
                                if (e) {
                                    log(`❌ Erreur connexion docker load: ${e.message}`);
                                    return rej(e);
                                }
                                
                                const fileStream = fs.createReadStream(tarPath);
                                const stats = fs.statSync(tarPath);
                                const totalSize = stats.size;
                                
                                fileStream.on('data', (chunk) => {
                                    bytesTransferred += chunk.length;
                                    const progress = ((bytesTransferred / totalSize) * 100).toFixed(1);
                                    if (bytesTransferred % (10 * 1024 * 1024) === 0 || bytesTransferred === totalSize) {
                                        log(`⏳ Transfert: ${progress}% (${(bytesTransferred / 1024 / 1024).toFixed(2)} MB)`);
                                    }
                                });
                                
                                fileStream.pipe(stream);
                                stream.on('data', (d) => log(`VM load: ${d.toString().trim()}`));
                                stream.on('end', () => {
                                    log(`✅ Image ${service.name} chargée sur la VM`);
                                    res();
                                });
                                stream.on('error', (err) => {
                                    log(`❌ Erreur stream: ${err.message}`);
                                    rej(err);
                                });
                            });
                        });

                        // 6. Lancement
                        log(`🏃 Démarrage du conteneur ${service.container}...`);
                        log(`🔧 Commande: docker run -d --name ${service.container} -p ${service.port} ${service.image}`);
                        await new Promise((res, rej) => {
                            conn.exec(`docker run -d --name ${service.container} -p ${service.port} ${service.image}; exit`, (e, stream) => {
                                if (e) {
                                    log(`❌ Erreur lancement conteneur: ${e.message}`);
                                    return rej(e);
                                }
                                stream.on('data', (data) => log(`VM run: ${data.toString().trim()}`));
                                stream.on('end', () => {
                                    log(`✅ Conteneur ${service.container} démarré`);
                                    if (fs.existsSync(tarPath)) {
                                        fs.unlinkSync(tarPath);
                                        log(`🗑️ Archive ${service.name}.tar supprimée`);
                                    }
                                    res();
                                });
                                stream.on('error', (err) => {
                                    log(`❌ Erreur stream run: ${err.message}`);
                                    rej(err);
                                });
                                stream.resume();
                            });
                        });
                        log(`✅ Service ${service.name} déployé avec succès sur port ${service.port}`);
                    }

                    conn.end();
                    log("🎉 PIPELINE FULL-STACK TERMINÉ AVEC SUCCÈS !");
                    log("📊 Tous les services sont opérationnels sur la VM");
                    resolve();
                }).connect({
                    host: process.env.VM_IP || '192.168.20.128',
                    port: 22,
                    username: 'debian',
                    privateKey: fs.readFileSync('/root/.ssh/id_deploy_tp'),
                    passphrase: 'debian'
                });

            } catch (error) {
                log("❌ Erreur pendant le déploiement : " + error.message);
                reject(error);
            }
        });
    });
};

// --- ROUTES ---
app.get('/api/pipeline/logs', (req, res) => res.json({ logs: pipelineLogs }));

app.post('/api/pipeline/deploy', (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    runFullPipeline()
        .then(() => res.json({ success: true }))
        .catch(err => {
            pipelineLogs.push(`❌ ERREUR: ${err}`);
            res.status(500).json({ success: false, error: err });
        });
});

app.post('/api/webhook', (req, res) => {
    if (req.headers['x-github-event'] === 'push' && req.body.ref === 'refs/heads/main') {
        runFullPipeline().catch(console.error);
    }
    res.status(200).send('OK');
});

app.get('/api/user', (req, res) => res.json(req.user || null));
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email'] }));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => res.redirect('http://localhost:3000'));

app.listen(PORT, () => console.log(`Back-end prêt sur le port ${PORT}`));
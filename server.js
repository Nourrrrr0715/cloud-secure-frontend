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

app.use(cors({ origin: 'http://localhost:3000', credentials: true }));
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
                port: '3000:3000',
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

        // 1. Git Pull
        const fetchCmd = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone https://github.com/ML-Laurane/Appli-PCS.git ${projectPath}`;

        exec(fetchCmd, async (err) => {
            if (err) return reject("Erreur Git: " + err.message);
            log("✅ Code source mis à jour.");

            try {
                const conn = new Client();
                conn.on('ready', async () => {
                    log("📡 Connexion SSH établie.");

                    for (const service of services) {
                        log(`--- Service : ${service.name.toUpperCase()} ---`);
                        const tarPath = path.join(workspace, `${service.name}.tar`);

                        // 2. Build local
                        log(`🔨 Build de l'image ${service.image}...`);
                        await new Promise((res, rej) => {
                            exec(`docker build -t ${service.image} ${service.path}`, (e) => e ? rej(e) : res());
                        });

                        // 3. Export .tar
                        log(`📦 Création de l'archive ${service.name}.tar...`);
                        await new Promise((res, rej) => {
                            exec(`docker save ${service.image} -o ${tarPath}`, (e) => e ? rej(e) : res());
                        });

                        // 4. Nettoyage VM pour ce port précis
                        log(`🧹 Arrêt de l'ancien conteneur sur le port ${service.port.split(':')[0]}...`);
                        await new Promise((res) => {
                            const cleanCmd = `ids=$(docker ps -q --filter "publish=${service.port.split(':')[0]}"); if [ ! -z "$ids" ]; then docker stop $ids && docker rm $ids; fi; exit`;
                            conn.exec(cleanCmd, (e, stream) => {
                                stream.on('end', () => res());
                                stream.resume();
                            });
                        });

                        // 5. Transfert et Load
                        log(`📤 Transfert de l'image ${service.name} vers la VM...`);
                        await new Promise((res, rej) => {
                            conn.exec('docker load', (e, stream) => {
                                if (e) return rej(e);
                                fs.createReadStream(tarPath).pipe(stream);
                                stream.on('data', (d) => log(`VM: ${d.toString().trim()}`));
                                stream.on('end', () => res());
                            });
                        });

                        // 6. Lancement
                        log(`🏃 Lancement du conteneur ${service.container}...`);
                        await new Promise((res) => {
                            conn.exec(`docker run -d --name ${service.container} -p ${service.port} ${service.image}; exit`, (e, stream) => {
                                stream.on('end', () => {
                                    if (fs.existsSync(tarPath)) fs.unlinkSync(tarPath);
                                    res();
                                });
                                stream.resume();
                            });
                        });
                        log(`✅ Service ${service.name} déployé.`);
                    }

                    conn.end();
                    log("✨ PIPELINE FULL-STACK TERMINÉ AVEC SUCCÈS !");
                    resolve();
                }).connect({
                    host: '127.0.0.1',
                    port: 2222,
                    username: 'debian',
                    privateKey: fs.readFileSync('/Users/dev02/.ssh/id_deploy_tp')
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
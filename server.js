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
const axios = require('axios');

const app = express();
const PORT = 5001;
let pipelineLogs = [];

// Configuration CORS pour accepter les requêtes depuis le navigateur et le conteneur frontend
app.use(cors({
    origin: [
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://192.168.188.129:3000',
        'http://frontend:3000'
    ],
    credentials: true
}));
app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET || 'secret_secret',
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
}, (accessToken, refreshToken, profile, done) => {
    profile.accessToken = accessToken;
    return done(null, profile);
}));


const rollback = async (conn, service) => {
    return new Promise((res) => {
        const rollbackCmd = `
            docker stop ${service.container} || true
            docker rm ${service.container} || true
            docker run -d --name ${service.container} -p ${service.port} ${service.image}:previous || true
            exit
        `;
        conn.exec(rollbackCmd, () => res());
    });
};


// LOGIQUE DE PIPELINE
const runSSHCommand = (conn, cmd, log) => {
    return new Promise((resolve) => {
        conn.exec(`${cmd}; exit`, { pty: true }, (err, stream) => {
            if (err) { log(`❌ Erreur: ${err.message}`); return resolve(); }
            stream.on('data', (d) => log(`VM: ${d.toString().trim()}`));
            stream.on('end', () => resolve());
            stream.resume();
        });
    });
};

const runFullPipeline = (repoUrl, repoName, actionType) => {
    pipelineLogs = [];
    const log = (msg) => {
        const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
        pipelineLogs.push(entry);
        console.log(entry);
    };

    return new Promise((resolve, reject) => {
        const workspace = path.join(__dirname, 'workspace');
        const projectPath = path.join(workspace, repoName);
        const conn = new Client();

        conn.on('ready', async () => {
            log(`📡 Connecté à la VM. Action: ${actionType}`);

            if (actionType === 'CHECK_STATUS') {
                await runSSHCommand(conn, "uptime && docker ps", log);
            }
            else if (actionType === 'CLEAN_VM') {
                log("🧹 Nettoyage global de Docker...");
                await runSSHCommand(conn, "docker system prune -af", log);
            }
            else if (actionType === 'FULL_DEPLOY') {
                log(`🚀 Déploiement complet de ${repoName}`);
                const fetchCmd = fs.existsSync(projectPath) ? `git -C ${projectPath} pull` : `git clone ${repoUrl} ${projectPath}`;

                exec(fetchCmd, async (err) => {
                    if (err) {
                        log(`❌ Erreur git: ${err.message}`);
                        conn.end();
                        return reject(err);
                    }
                    log("✅ Code récupéré. Début du Build & Transfert...");

                    const services = [
                        { name: 'frontend', image: 'app-front:latest', port: '3000:80', path: path.join(projectPath, 'frontend') },
                        { name: 'backend', image: 'app-back:latest', port: '8080:8080', path: path.join(projectPath, 'backend') }
                    ];

                    try {
                        for (const service of services) {
                            log(`\n--- 🚢 Service : ${service.name.toUpperCase()} ---`);
                            const tarPath = path.join(workspace, `${service.name}.tar`);
                            log(`📁 Chemin de l'image : ${service.path}`);
                            log(`💾 Archive : ${tarPath}`);

                            // === Tests unitaires + SonarQube (BACKEND SEULEMENT) ===
                            if (service.name === 'backend') {
                                log("🧪 Lancement des tests unitaires...");

                                const testsOK = await new Promise((res) => {
                                    exec(
                                        'mvn clean test',
                                        { cwd: service.path },
                                        (e, stdout, stderr) => {

                                            if (e) {
                                                log("❌ Échec des tests unitaires"); // seulement message essentiel
                                                return res(false);
                                            }

                                            log("✅ Tests unitaires réussis"); // seulement message essentiel
                                            res(true);
                                        }
                                    );
                                });

                                if (!testsOK) {
                                    log("🔁 Déclenchement du rollback...");
                                    await rollback(conn, service);
                                    log("⛔ Pipeline arrêté (tests KO)");
                                    conn.end();
                                    return; // ⛔ STOP TOTAL DU PIPELINE
                                }

                                log("📊 Lancement de l'analyse SonarQube...");

                                const sonarOK = await new Promise((res) => {
                                    exec(
                                        'mvn clean verify sonar:sonar ' +
                                        `"-Dsonar.projectKey=${process.env.SONAR_PROJECT_KEY}" ` +
                                        `"-Dsonar.host.url=${process.env.SONAR_HOST_URL}" ` +
                                        `"-Dsonar.login=${process.env.SONAR_TOKEN}"`,
                                        {
                                            cwd: service.path,
                                            env: {
                                                ...process.env,
                                                SONAR_HOST_URL: process.env.SONAR_HOST_URL,
                                                SONAR_TOKEN: process.env.SONAR_TOKEN,
                                                SONAR_PROJECT_KEY: process.env.SONAR_PROJECT_KEY
                                            }
                                        },
                                        (e, stdout, stderr) => {

                                            if (e) {
                                                if (stdout) log(stdout);
                                                if (stderr) log(stderr);

                                                log("❌ Échec analyse SonarQube");
                                                return res(false);
                                            }

                                            log("✅ Analyse SonarQube terminée");
                                            res(true);
                                        }
                                    );
                                });

                                if (!sonarOK) {
                                    log("🔁 Déclenchement du rollback...");
                                    await rollback(conn, service);
                                    log("⛔ Pipeline arrêté (Sonar KO)");
                                    conn.end();
                                    return;
                                }
                            }

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
                        log("✨ Opération terminée.");
                        resolve();
                    } catch (e) {
                        log(`❌ Erreur: ${e.message}`);
                        conn.end();
                        reject(e);
                    }
                });
                return; // Important: ne pas exécuter conn.end() immédiatement
            }

            conn.end();
            log("✨ Opération terminée.");
            resolve();
        }).on('error', (err) => {
            log(`❌ Erreur de connexion SSH: ${err.message}`);
            log(`💡 Détails: ${err.level || 'N/A'}`);
            conn.end();
            reject(err);
        }).on('timeout', () => {
            log('❌ Timeout de connexion SSH');
            conn.end();
            reject(new Error('SSH connection timeout'));
        }).on('keyboard-interactive', (name, instructions, instructionsLang, prompts, finish) => {
            log('🔐 Authentification interactive requise');
            finish(['debian']);
        }).connect({
            host: process.env.VM_IP || '192.168.20.128',
            port: 22,
            username: 'debian',
            password: 'debian',
            privateKey: fs.readFileSync(path.join(__dirname, 'certs', 'id_deploy_tp2')),
            passphrase: 'debian',
            tryKeyboard: true,
            readyTimeout: 10000
        });
    });
};

// ROUTES
app.get('/api/user', async (req, res) => {
    if (!req.user) return res.json(null);
    res.json({
        username: req.user.username,
        avatar: req.user._json.avatar_url
    });
});

app.get('/api/github/repos', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    try {
        const response = await axios.get('https://api.github.com/user/repos?per_page=100', {
            headers: { Authorization: `token ${req.user.accessToken}` }
        });
        res.json(response.data.map(r => ({
            name: r.name,
            url: r.clone_url,
            canPush: r.permissions.push // C'est ici qu'on voit si tu es contributeur
        })));
    } catch (e) { res.status(500).send(e.message); }
});

app.post('/api/pipeline/action', async (req, res) => {
    if (!req.isAuthenticated()) return res.status(401).send();
    const { repoUrl, repoName, actionType, canPush } = req.body;

    // Sécurité Identités : Seul un contributeur peut déployer ou nettoyer
    if (!canPush && actionType !== 'CHECK_STATUS') {
        return res.status(403).json({ error: "Droits de contributeur requis pour cette action." });
    }

    runFullPipeline(repoUrl, repoName, actionType)
        .then(() => res.json({ success: true }))
        .catch(err => {
            pipelineLogs.push(`❌ PIPELINE ARRÊTÉ: ${err}`);
            res.json({ success: false, reason: err });
        });

});

app.get('/api/pipeline/logs', (req, res) => res.json({ logs: pipelineLogs }));
app.get('/auth/github', passport.authenticate('github', { scope: ['user:email', 'repo'] }));
app.get('/auth/github/callback', passport.authenticate('github', { failureRedirect: '/' }), (req, res) => res.redirect('http://localhost:3000'));

app.listen(PORT, () => console.log(`Serveur prêt sur ${PORT}`));
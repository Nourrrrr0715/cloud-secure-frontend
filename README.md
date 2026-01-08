
# 🚀 CloudSecure CI/CD : Pipeline d'Images Immuables

[![Status](https://img.shields.io/badge/Status-Production--Ready-success?style=for-the-badge)]()
[![Docker](https://img.shields.io/badge/Docker-Enabled-blue?style=for-the-badge&logo=docker)]()
[![SSH](https://img.shields.io/badge/SSH-Secure--Tunnel-lightgrey?style=for-the-badge&logo=ssh)]()

Ce projet implémente une infrastructure **CI/CD automatisée** permettant le déploiement de micro-services (Frontend & Backend) depuis un poste de contrôle vers une **VM Debian 12** via un transfert d'artefacts (Images Docker).

---

## 🏗️ Architecture du Pipeline

Le pipeline ne repose pas sur un simple `git pull` distant (sujet aux dérives), mais sur la création d'images immuables sur le nœud de build.

1.  **Déclenchement** : Webhook GitHub (Auto) ou Dashboard React (Manuel).
2.  **Build** : Compilation des Dockerfiles sur le poste local.
3.  **Export** : Sérialisation des images en archives `.tar`.
4.  **Transfert** : Injection directe dans le moteur Docker de la VM via **Stream SSH**.
5.  **Déploiement** : Nettoyage des ports et instanciation des nouveaux conteneurs.

---

## 🛠️ Pré-requis

* **Node.js** v18+
* **Docker Desktop** (lancé sur le poste hôte)
* **VirtualBox** avec la VM Debian configurée (IP: `127.0.0.1`, Port SSH: `22`)

---

## 🚀 Installation & Lancement

### 1. Configuration de la VM
Assurez-vous que Docker est installé sur la VM et que la clé publique du projet est autorisée :
```bash
# Dans la VM Debian
sudo apt update && sudo apt install -y docker.io
# La clé publique est dans certs/id_deploy_tp2.pub
cat id_deploy_tp.pub >> ~/.ssh/authorized_keys
```

### 2\. Configuration du projet

Clonez le projet et installez les dépendances :

```Bash
npm install
```


### 3\. Variables d'environnement

Créez un fichier `.env` à la racine du projet :

Extrait de code

```
GITHUB_CLIENT_ID=votre_id
GITHUB_CLIENT_SECRET=votre_secret
SESSION_SECRET=votre_secret_aleatoire
VM_IP=127.0.0.1
VM_PORT=22
```


### 4\. Lancement

```Bash
# Lancer le serveur (Port 5001)
node server.js

# Lancer le frontend (Port 3000)
cd client && npm start
```


* * * * *

🔒 Sécurité & Portabilité
-------------------------

> 🚨 IMPORTANT 🚨
>
> Pour faciliter l'évaluation, les clés SSH sont incluses dans le dossier /.ssh.
>
> Note technique : Dans un environnement réel, ces clés seraient injectées via un Vault (Secrets Manager).

Droits sur les clés :

Si vous êtes sur Linux/Mac, SSH impose des permissions strictes sur la clé privée :

```Bash
chmod 600 .ssh/id_deploy_tp
```


* * * * *

📊 Fonctionnalités Clés
-----------------------

| **Fonctionnalité** | **Description**                                                          |
| --- |--------------------------------------------------------------------------|
| **Full-Stack Build** | Build parallèle du Frontend (3000) et du Backend (8080).                 |
| **Real-time Logs** | Streaming des flux STDOUT de la VM vers l'interface React.               |
| **Port Cleaning** | Détection et arrêt automatique des conteneurs occupant les ports cibles. |
| **Immuabilité** | Transfert d'images `.tar` pour garantir la parité entre Dev et Prod.     |
| **Webhooks** | Intégration Ngrok/GitHub pour le déploiement continu au `git push`.      |

* * * * *

👨‍💻 Structure du Projet
-------------------------

```Plaintext
.
├── .ssh/               # Clés SSH de déploiement (Portabilité)
├── src/              # Interface Dashboard (React)
├── workspace/           # Espace temporaire de build (Images .tar)
├── server.js            # Orchestrateur du pipeline (Node/SSH2)
└── .env                 # Configuration sensible
```
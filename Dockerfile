# Multi-stage build pour optimiser la taille de l'image

# Stage 1: Build de l'application React
FROM node:18-alpine AS build

WORKDIR /app

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer les dépendances
RUN npm ci --only=production

# Copier le reste des fichiers
COPY . .

# Build de l'application React
RUN npm run build

# Stage 2: Image de production
FROM node:18-alpine

WORKDIR /app

# Installer git et openssh pour les opérations SSH/Git
RUN apk add --no-cache git openssh-client docker-cli docker-compose

# Copier les fichiers de dépendances
COPY package*.json ./

# Installer uniquement les dépendances de production
RUN npm ci --only=production

# Copier le serveur et les fichiers de configuration
COPY server.js ./
COPY --from=build /app/build ./build

# Créer le dossier workspace
RUN mkdir -p /app/workspace

# Exposer le port du serveur
EXPOSE 5001

# Variable d'environnement pour le port
ENV PORT=5001

# Démarrer le serveur
CMD ["node", "server.js"]

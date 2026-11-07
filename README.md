# 💬 Fluxer Chat

> Zero-cost real-time chat — deployed across Render, Neon, and GitHub Pages.

## Architecture

```
User → GitHub Pages (frontend)
         ↓ HTTPS + WSS
       Render (backend)
         ↓ TCP/SSL
       Neon (PostgreSQL)

GitHub Actions keeps the backend awake every 10 minutes.
```

## Stack

| Layer | Service | Cost |
|-------|---------|------|
| **Frontend** | GitHub Pages | Free |
| **Backend** | Render (Docker, free tier) | Free |
| **Database** | Neon (Serverless PostgreSQL) | Free |
| **CI/CD** | GitHub Actions | Free (public repo) |

## Project Structure

```
├── .github/workflows/
│   ├── deploy-frontend.yml   # Build & deploy to GitHub Pages
│   ├── deploy-backend.yml    # Trigger Render deploy via webhook
│   └── keep-alive.yml        # Ping backend every 10 min
├── backend/
│   ├── server.js             # Express + WebSocket server
│   ├── package.json
│   └── .env.example
├── frontend/                 # Frontend app (add your code here)
├── Dockerfile                # Multi-stage production build
└── render.yaml               # Render Blueprint
```

## Setup

See the deployment guide for full step-by-step instructions.

## License

MIT

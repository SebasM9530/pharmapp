# 🧬 PharmaChem — App de Estudio Farmacológico
Powered by **Groq + Llama 4 Scout** · Gratis

## 🚀 Correr en local
```bash
cd pharmapp
npm install
npm start
# Abre http://localhost:3000
```

## 🌐 Subir a internet GRATIS (Render.com)

### Paso 1 — Subir a GitHub
1. Ve a github.com → New repository → nombre: `pharmapp` → Create
2. En PowerShell dentro de la carpeta pharmapp:
```powershell
git init
git add .
git commit -m "PharmaChem app"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/pharmapp.git
git push -u origin main
```

### Paso 2 — Deploy en Render
1. Ve a **render.com** → Sign up con GitHub (gratis)
2. New → Web Service → conecta tu repo `pharmapp`
3. Configuración:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. En **Environment Variables** agrega:
   - Key: `GROQ_API_KEY`
   - Value: tu key de Groq (`gsk_...`)
5. Clic en **Deploy** → en 2 minutos tienes URL pública 🎉

## 📋 Variables de entorno necesarias
| Variable | Valor |
|---|---|
| `GROQ_API_KEY` | tu key de console.groq.com |

## 🤖 Modelo usado
`meta-llama/llama-4-scout-17b-16e-instruct` — 500K tokens/día gratis

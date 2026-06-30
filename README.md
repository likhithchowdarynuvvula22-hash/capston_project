# 🌟 EduStar — AI-Powered Learning Platform for School Students

> **Free. Ad-free. Login-free.** A space-and-adventure themed educational platform for students from Class 1 to Class 12, built with AI tutoring, interactive quizzes, progress tracking, and curriculum-mapped content.

---

## 📌 Table of Contents

- [Problem Statement](#-problem-statement)
- [Solution](#-solution)
- [Features](#-features)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Database Schema](#-database-schema)
- [Project Structure](#-project-structure)
- [Setup & Installation](#-setup--installation)

---

## ❓ Problem Statement

Students in India (Classes 1–12) often face:
- Lack of **free, high-quality, curriculum-aligned** digital learning resources
- No **personalized learning experience** or progress tracking
- Overwhelming, **ad-heavy or login-gated** platforms
- No lightweight tools that work well on low-end devices

---

## ✅ Solution

**EduStar** is a lightweight, self-hosted AI learning platform that:
- Covers **CBSE curriculum topics** across all grades (Class 1–12)
- Provides an **AI tutor** for real-time conversational Q&A
- Tracks **individual learner progress** using a device-based identity (no login required)
- Features **interactive quizzes**, a **learning journal**, and personal **notes**
- Works entirely in the browser with a minimal Node.js backend — **zero npm dependencies**

---

## ✨ Features

| Feature | Description |
|---|---|
| 🏠 Home Page | Space-themed landing page with grade selector |
| 📚 CBSE Class Hub | Curriculum-mapped content for Class 1–12 |
| 🤖 AI Tutor | Conversational AI assistant for learning support |
| 🧠 Quiz Engine | Subject-wise quizzes with scoring and history |
| 📈 Progress Tracker | Stars, levels, and completed lesson tracking |
| 📝 Notes | Per-device personal notes saved to the backend |
| 📓 Journal | Daily learning journal with timestamped entries |
| 🎓 Values & Character | Life skills and character-building modules |
| 🌌 AI Tech Centre | Dedicated AI and technology learning hub |
| 🔧 Admin Panel | Debug dashboard to inspect all stored learner data |

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   BROWSER (Client)                   │
│                                                      │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ HTML Pages │  │  CSS / JS    │  │client-api.js│ │
│  │ (EduStar)  │  │ (Design Sys) │  │(fetch calls)│ │
│  └────────────┘  └──────────────┘  └──────┬──────┘ │
└─────────────────────────────────────────── │ ───────┘
                                             │ HTTP REST
┌─────────────────────────────────────────── │ ───────┐
│              NODE.JS BACKEND (Server)       │        │
│                                             ▼        │
│  ┌──────────────────────────────────────────────┐   │
│  │            edustar-backend.mjs               │   │
│  │  ┌─────────────┐   ┌────────────────────┐   │   │
│  │  │ HTTP Server │   │   Route Handlers   │   │   │
│  │  │ (node:http) │   │ /api/settings      │   │   │
│  │  └─────────────┘   │ /api/progress      │   │   │
│  │                    │ /api/notes         │   │   │
│  │                    │ /api/journal       │   │   │
│  │                    │ /api/quiz-attempts │   │   │
│  │                    │ /api/tutor/chat    │   │   │
│  │                    │ /api/content-map   │   │   │
│  │                    └─────────┬──────────┘   │   │
│  └──────────────────────────────│──────────────┘   │
│                                 ▼                   │
│  ┌──────────────────────────────────────────────┐   │
│  │         SQLite Database (node:sqlite)        │   │
│  │                                              │   │
│  │  app_settings  │  progress  │  notes         │   │
│  │  journal_entries  │  quiz_attempts            │   │
│  │  tutor_messages                              │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
```

### How It Works

1. **No Authentication** — Each browser gets a unique `deviceId` stored in `localStorage`. All data is keyed to this ID.
2. **Static File Serving** — The Node backend serves HTML/CSS/JS files directly (no bundler or framework needed).
3. **REST API** — The frontend communicates with the backend via `edustar-client-api.js` using simple `fetch()` calls.
4. **SQLite Storage** — All learner data is persisted in a local `edustar-data.sqlite` file using Node 24's built-in SQLite module (no `better-sqlite3` or other package needed).
5. **AI Tutor** — The `/api/tutor/chat` endpoint processes learner questions with keyword-based logic and stores the full conversation history per device.

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | HTML5, Vanilla CSS, Vanilla JavaScript |
| **Backend** | Node.js 24 (ESM modules, no frameworks) |
| **Database** | SQLite via `node:sqlite` (Node built-in — no npm package) |
| **HTTP Server** | `node:http` (Node built-in) |
| **Deployment** | Railway (with `Procfile` + `railway.toml`) |
| **Dependencies** | **Zero** — `npm install` is not required |

---

## 🗄️ Database Schema

```sql
-- Learner settings (grade selection, display name)
CREATE TABLE app_settings (
  device_id     TEXT PRIMARY KEY,
  user_name     TEXT NOT NULL DEFAULT '',
  selected_grade INTEGER NOT NULL DEFAULT 1,
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Learning progress (stars, level, completed lessons)
CREATE TABLE progress (
  device_id         TEXT PRIMARY KEY,
  stars             INTEGER NOT NULL DEFAULT 0,
  level             INTEGER NOT NULL DEFAULT 1,
  completed_lessons INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Personal notes (one note document per device)
CREATE TABLE notes (
  device_id TEXT PRIMARY KEY,
  note_text TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Daily learning journal (multiple entries per device)
CREATE TABLE journal_entries (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  entry_text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Quiz history (score tracking per subject pillar)
CREATE TABLE quiz_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  pillar     TEXT NOT NULL,
  score      INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AI tutor conversation history
CREATE TABLE tutor_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT NOT NULL,
  role       TEXT NOT NULL,  -- 'user' or 'assistant'
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

---

## 📁 Project Structure

```
capston_project/
├── edustar-backend.mjs               # Node.js HTTP server + all API routes
├── edustar-client-api.js             # Frontend REST client (fetch wrappers)
├── edustar-schema.sql                # SQLite schema definition
├── edustar-content-map.json          # Curriculum content map (all grades)
├── edustar-quiz-questions.json       # Quiz question bank
│
├── edustar-home.html                 # 🏠 Landing page
├── edustar-cbse-class-hub.html       # 📚 CBSE class content hub
├── edustar-ai-tech-learning-centre.html  # 🌌 AI & Technology hub
├── edustar-ai-tutor.html             # 🤖 AI tutor chat interface
├── edustar-quiz.html                 # 🧠 Quiz engine
├── edustar-progress-tracker.html     # 📈 Progress dashboard
├── edustar-subject-hub.html          # 📖 Subject-wise content browser
├── edustar-values-character.html     # 🎓 Values & life skills module
├── edustar-video-player.html         # 🎬 Video lesson player
│
├── edustar-navbar.html               # Shared navigation component
├── edustar-footer.html               # Shared footer component
├── edustar-design-system.css         # Design tokens & global styles
├── edustar-navbar.css                # Navbar styles
├── edustar-footer.css                # Footer styles
├── edustar-starfield.js              # Animated starfield background
│
├── edustar-admin-debug.html          # 🔧 Admin/debug panel
├── package.json                      # Node project config (no dependencies)
├── Procfile                          # Railway process definition
├── railway.toml                      # Railway build configuration
└── run-edustar.ps1                   # Windows one-click start script
```

---

## ⚙️ Setup & Installation

### Prerequisites

- **Node.js v22.5.0 or higher** (v24 recommended for native SQLite support)
- No other tools, packages, or frameworks required!

### Quick Start (Windows)

```powershell
# 1. Clone the repository
git clone https://github.com/likhithchowdarynuvvula22-hash/capston_project.git
cd capston_project

# 2. Start the server with the one-click script
powershell -ExecutionPolicy Bypass -File .\run-edustar.ps1
```

### Manual Start (Any OS)

```bash
# Clone and navigate
git clone https://github.com/likhithchowdarynuvvula22-hash/capston_project.git
cd capston_project

# Start the backend
node --experimental-sqlite edustar-backend.mjs
```

### Access the App

Open your browser and go to:

```
http://127.0.0.1:3000/edustar-home.html
```

### All Pages

| URL | Page |
|---|---|
| `/edustar-home.html` | 🏠 Home — Grade selector & welcome |
| `/edustar-cbse-class-hub.html` | 📚 CBSE Class Hub |
| `/edustar-ai-tech-learning-centre.html` | 🌌 AI Tech Centre |
| `/edustar-ai-tutor.html` | 🤖 AI Tutor Chat |
| `/edustar-quiz.html` | 🧠 Quiz Engine |
| `/edustar-progress-tracker.html` | 📈 Progress Tracker |
| `/edustar-values-character.html` | 🎓 Values & Character |
| `/edustar-admin-debug.html` | 🔧 Admin Debug Panel |

---

## 👨‍💻 Author

**Likhith Chowdary Nuvvula**
- GitHub: [@likhithchowdarynuvvula22-hash](https://github.com/likhithchowdarynuvvula22-hash)

---

## 📄 License

MIT License — free to use, modify, and distribute.

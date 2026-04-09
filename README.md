# App

> I'm helping a friend moving lots of books.
> I wanted to build a system to quickly track where books end up on shelves using QR codes and a mobile app.
> Claude (and others) are helping me helping my friend. 🙂
> This repo is the codebase for that project.

This repository contains the Expo mobile client for the main Shelfscan project:
https://github.com/cavenditti/invenioScan

Minimal Expo client for the first implementation slice.

## Current capabilities

- Login against the FastAPI backend.
- Persist the JWT and backend URL in secure storage.
- Submit manual ingest requests with shelf metadata.
- On web, paste shelf QR payloads or ISBNs when browser scanning is unreliable.
- Capture and upload a book cover even when no ISBN is available.
- Optionally fill in title and author.

## Run

```bash
npm install
npm start
```

Set the backend URL in the login form to the machine running the FastAPI API.
# App

> I'm helping a friend moving lots of books.
> I wanted to build a system to quickly ingest a large number of items into InvenioILS using QR codes and a mobile app.
> Claude (and others) are helping me helping my friend. 🙂
> (I later decided to not use InvenioILS at all)
> This repo is the codebase for that project.

This repository contains the Expo mobile client for the main InvenioScan project:
https://github.com/cavenditti/invenioScan

Minimal Expo client for the first implementation slice.

## Current capabilities

- Login against the FastAPI backend.
- Persist the JWT and backend URL in secure storage.
- Submit manual ingest requests with shelf metadata.
- Optionally fill in title and author.

## Run

```bash
npm install
npm start
```

Set the backend URL in the login form to the machine running the FastAPI API.
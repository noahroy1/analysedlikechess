import { Hono } from 'hono';

export const app = new Hono().basePath('/api');

app.get('/health', (c) => c.json({ ok: true }));

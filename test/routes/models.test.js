import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import modelsRouter from '../../src/routes/models.js';

function createApp() {
  const app = express();
  app.use('/v1', modelsRouter);
  return app;
}

describe('models routes', () => {
  it('returns available models', async () => {
    const app = createApp();
    const response = await request(app).get('/v1/models');

    expect(response.status).toBe(200);
    expect(response.body.object).toBe('list');
    expect(response.body.data.length).toBeGreaterThan(0);
  });

  it('returns a specific model', async () => {
    const app = createApp();
    const response = await request(app).get('/v1/models/claude-opus-4-5-thinking');

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('claude-opus-4-5-thinking');
  });

  it('returns an alias model with the requested id', async () => {
    const app = createApp();
    const response = await request(app).get('/v1/models/claude-opus-4-5');

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('claude-opus-4-5');
  });

  it('returns a version-suffixed model id when mapped', async () => {
    const app = createApp();
    const response = await request(app).get('/v1/models/claude-opus-4-5-thinking-2025-01-01');

    expect(response.status).toBe(200);
    expect(response.body.id).toBe('claude-opus-4-5-thinking-2025-01-01');
  });

  it('returns a not_found_error for unknown models', async () => {
    const app = createApp();
    const response = await request(app).get('/v1/models/unknown-model');

    expect(response.status).toBe(404);
    expect(response.body.error.type).toBe('not_found_error');
  });
});

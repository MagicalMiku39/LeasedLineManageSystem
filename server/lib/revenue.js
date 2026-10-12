import express from 'express';
import multer from 'multer';
import { createHash } from 'node:crypto';
import { createRevenueStore } from './revenue-store.js';
import { RevenueError, fail } from './revenue-money.js';

// Mount AFTER requireAuth. The factory never imports the application's singleton DB.
export function createRevenueRouter({ db, uploadDir, leasedLineSource }) {
  const store = createRevenueStore({ db, uploadDir, leasedLineSource });
  const router = express.Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 32 * 1024 * 1024, files: 1, fields: 0 } });
  router.use(express.json({ limit: '64kb' }));

  function actor(req) {
    if (req.user?.username) return req.user.username;
    // Existing requireAuth validates a cookie but does not attach the user to req.
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith('ledger_session='));
    if (!cookie) fail('无法确认操作人，请重新登录');
    let token;
    try { token = decodeURIComponent(cookie.slice('ledger_session='.length)); }
    catch { fail('登录会话格式无效'); }
    const user = db.prepare(`SELECT u.username FROM auth_session s JOIN auth_user u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?`).get(createHash('sha256').update(token).digest('hex'), new Date().toISOString());
    if (!user) fail('登录会话已失效，请重新登录');
    return user.username;
  }

  router.get('/meta', (req, res) => res.json(store.meta()));
  router.post('/imports/preview', upload.single('file'), (req, res) => {
    if (!req.file) fail('请选择 Excel 文件');
    res.json(store.preview(req.file.buffer, req.file.originalname, actor(req)));
  });
  router.post('/imports/:id/commit', (req, res) => res.json(store.commit(req.params.id, req.body, actor(req))));
  router.get('/summary', (req, res) => res.json(store.summary(req.query)));
  router.get('/groups/:code/services', (req, res) => res.json(store.detail(req.params.code, req.query).services));
  router.get('/groups/:code', (req, res) => res.json(store.detail(req.params.code, req.query)));
  router.post('/services', (req, res) => res.json(store.saveService(null, req.body, actor(req))));
  router.put('/services/:id', (req, res) => res.json(store.saveService(req.params.id, req.body, actor(req))));
  router.delete('/services/:id', (req, res) => res.json(store.deleteService(req.params.id, actor(req), req.body?.version)));
  router.get('/settings', (req, res) => res.json(store.settings()));
  router.put('/settings', (req, res) => res.json(store.settings(req.body, actor(req))));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const known = error instanceof RevenueError;
    const inputError = error instanceof multer.MulterError || error.type === 'entity.parse.failed' || error.type === 'entity.too.large' || error instanceof URIError;
    res.status(known || inputError ? 400 : 500).json({ error: known ? error.message : inputError ? '请求格式无效或上传文件超过 32MB 限制' : '收入模块操作失败，请稍后重试' });
  });
  return router;
}

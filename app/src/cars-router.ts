import { Router, Request, Response } from 'express'
const router = Router()

router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true })
})

router.post('/connect', (req: Request, res: Response) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ ok: false, error: 'url manquante' })
  return res.json({ ok: true, provider: 'autoscout24', url })
})

router.post('/preview', (req: Request, res: Response) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ ok: false, error: 'url manquante' })
  return res.json({ ok: true, sample: [] })
})

router.post('/import', (req: Request, res: Response) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ ok: false, error: 'url manquante' })
  return res.json({ ok: true, imported: 0 })
})

router.post('/resync', (_req: Request, res: Response) => {
  return res.json({ ok: true, scheduled: true })
})

export default router

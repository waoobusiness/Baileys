
// app/src/cars-router.ts
import { Router, Request, Response } from 'express'

const router = Router()

// ping
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true })
})

// connect: reçoit l’URL (garage ou véhicule), la valide, renvoie un petit résumé
router.post('/connect', async (req: Request, res: Response) => {
  const { url } = req.body || {}
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url manquante' })
  }
  // TODO: valider le domaine/forme ici si besoin
  return res.json({ ok: true, provider: 'autoscout24', url })
})

// preview: retourne un échantillon (ex: 1–3 voitures ou infos du garage)
router.post('/preview', async (req: Request, res: Response) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ ok: false, error: 'url manquante' })
  // TODO: appeler ton scraper ici
  return res.json({ ok: true, sample: [] })
})

// import: lance l’import en base (à brancher sur Supabase)
router.post('/import', async (req: Request, res: Response) => {
  const { url } = req.body || {}
  if (!url) return res.status(400).json({ ok: false, error: 'url manquante' })
  // TODO: scrape + upsert DB ici
  return res.json({ ok: true, imported: 0 })
})

// resync: relance un import périodique
router.post('/resync', async (_req: Request, res: Response) => {
  // TODO: relancer le job d’import (toutes les sources connues)
  return res.json({ ok: true, scheduled: true })
})

export default router

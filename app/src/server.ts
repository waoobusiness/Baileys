import express from 'express'
let ctx = SESSIONS.get(id)
if (!ctx?.sock) ctx = await startSocket(id)
try {
const url = await ctx.sock.profilePictureUrl(jid, 'image')
if (req.query.json === '1') return res.json({ url })
if (url) return res.redirect(url)
return res.status(404).json({ error: 'not-found' })
} catch (e: any) {
return res.status(500).json({ error: e?.message || 'failed' })
}
})


// --- Media download (stream)
app.get('/sessions/:id/messages/:msgId/media', authenticateApiKey, async (req, res) => {
try {
const id = String(req.params.id)
const msgId = String(req.params.msgId)
const bag = MSG_CACHE.get(id)
const entry = bag?.get(msgId)
if (!entry) return res.status(404).json({ ok: false, error: 'message not found in cache' })


let ctx = SESSIONS.get(id)
if (!ctx?.sock) ctx = await startSocket(id)


const content = resolveMessageContent({ message: entry.message })
const media = sniffMediaKind(content)
const mime = media.node?.mimetype || 'application/octet-stream'


const stream = await downloadMediaMessage(
{ key: entry.key, message: entry.message },
'stream',
{},
{ logger, reuploadRequest: ctx.sock.updateMediaMessage }
)


res.setHeader('Content-Type', mime)
if (media.node?.fileLength) res.setHeader('Content-Length', String(media.node.fileLength))
if (req.query.download === '1') {
const ext = (mime.split('/')[1] || 'bin').split(';')[0]
res.setHeader('Content-Disposition', `attachment; filename="${msgId}.${ext}"`)
}


stream.pipe(res)
} catch (e: any) {
logger.error({ err: e?.stack || String(e) }, 'media download failed')
res.status(500).json({ ok: false, error: 'media download failed' })
}
})


// --------------------
// Boot
// --------------------
app.listen(PORT, () => {
logger.info({ DATA_DIR, AUTH_DIR: AUTH_ROOT, MEDIA_DIR }, `HTTP listening on :${PORT}`)
})


// auto-start default session lazily (only if someone calls it)

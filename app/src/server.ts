URL="https://zuria-wa.onrender.com"
KEY="MY_PRIVATE_FURIA_API_KEY_2025"

# 1) Init (QR)
curl -s -X POST "$URL/sessions/init" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"sessionId":"sess-001"}' | jq

# 2) QR (image)
curl -s -H "x-api-key: $KEY" -H "accept: image/png" \
  "$URL/sessions/sess-001/qr" --output qr.png

# 3) Pairing code (option)
curl -s -X POST "$URL/sessions/sess-001/pairing-code" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"phoneNumber":"4179xxxxxxx"}' | jq

# 4) Statut
curl -s -H "x-api-key: $KEY" "$URL/sessions/sess-001" | jq

# 5) Envoi de message
curl -s -X POST "$URL/sessions/sess-001/messages/send" \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"to":"4176xxxxxxx","text":"Hello from Zuria 🤖"}' | jq

# 6) Chats
curl -s -H "x-api-key: $KEY" "$URL/sessions/sess-001/chats?limit=20" | jq

# 7) Logout
curl -s -X POST -H "x-api-key: $KEY" "$URL/sessions/sess-001/logout" | jq

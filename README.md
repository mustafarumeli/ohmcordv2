# ohmcordv2

Arkadaşlar arası küçük grup (≤4) ses + text + ekran paylaşımı.

## Başlatma

Gereksinimler:
- Node.js (LTS önerilir)

Kurulum:

```bash
npm install
```

Geliştirme:

```bash
npm run dev
```

Varsayılan olarak:
- Signaling/Text server: `ws://localhost:8787`
- Desktop app: Electron (Vite dev server `http://localhost:5173`)

## TURN (opsiyonel ama bazen gerekli)

Bazı ağlarda (CGNAT/katı NAT) P2P bağlantılar kurulamayabilir. Bu durumda TURN sunucusu eklemeniz gerekir.

- ICE sunucuları şu an `apps/desktop/src/rtc/peerMesh.ts` içinde tanımlı.
- TURN eklemek için `iceServers` listesine TURN satırı ekleyin (örnek):

```ts
iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:YOUR_TURN_HOST:3478", username: "user", credential: "pass" }
]
```


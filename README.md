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
- Signaling/Text server: `ws://localhost:8080`
- Desktop app: Electron (Vite dev server `http://localhost:5173`)

## Server Docker

Server, dışarıdan erişim için `0.0.0.0` üzerinde dinleyecek şekilde ayarlıdır.

Çalıştırma:

```bash
docker compose up --build server
```

Adres:
- `ws://localhost:8080`

## TURN (opsiyonel ama bazen gerekli)

Bazı ağlarda (CGNAT/katı NAT) P2P bağlantılar kurulamayabilir. Bu durumda TURN sunucusu eklemeniz gerekir.

### 1) coturn ile TURN sunucusu (VPS/Prod)

Bu repo için önerilen TURN: [coturn/coturn](https://github.com/coturn/coturn).

- **Repo içi örnek config**: `infra/turn/`
- **Portlar** (örnek/dar aralık): `3478/udp`, `3478/tcp` (opsiyonel), `49160-49200/udp` (relay)
- VPS’te **firewall**’ı bu portlara göre açmalısın.

Docker ile çalıştırma (VPS’te):

```bash
cd infra/turn
cp .env.example .env
# .env içinde TURN_REALM / TURN_USER / TURN_PASS ayarla
docker compose up -d
```

> Statik TURN kullanıcı/şifreyi client’a koymak **risklidir** (sızarsa TURN sunucun abuse edilebilir). Bu yüzden relay port aralığını dar tuttuk ve firewall öneriyoruz. Uzun vadede TURN REST (time-limited credential) daha güvenli bir yaklaşımdır.

### 2) Desktop uygulamaya TURN bilgisini verme (Vite env)

Electron/renderer tarafı TURN’u `VITE_*` env’lerinden okur (`apps/desktop/src/rtc/peerMesh.ts`).

Kök dizinde `.env` oluşturarak örnek:

```bash
VITE_TURN_URLS=turn:YOUR_VPS_IP_OR_DOMAIN:3478?transport=udp
VITE_TURN_USERNAME=ohmcord
VITE_TURN_CREDENTIAL=change_me_strong_password
```

> `VITE_TURN_URLS` birden fazla URL alabilir (virgülle ayır): `turn:...udp,turn:...tcp` gibi.

### 3) (Geliştirici notu) ICE servers

ICE sunucuları `apps/desktop/src/rtc/peerMesh.ts` içinde oluşturulur. TURN env’leri dolu değilse sadece STUN kullanılır.

```ts
iceServers: [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "turn:YOUR_TURN_HOST:3478", username: "user", credential: "pass" }
]
```


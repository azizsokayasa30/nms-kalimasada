# Kalimasada NMS

Dashboard NOC untuk memantau perangkat jaringan. Engine monitoring-nya Zabbix. Aplikasi ini yang dipakai sehari-hari: perangkat, peta, alarm, dan suara browser.

Fase ini sudah berjalan:

- Login dengan peran Super Admin, Admin, NOC, dan Viewer
- Tambah, ubah, dan hapus perangkat
- Aturan ping: 3 gagal berturut-turut baru DOWN, 2 berhasil baru UP
- Dashboard, topologi React Flow, alarm, acknowledge, dan suara browser
- Anak dari perangkat yang DOWN berstatus UNREACHABLE tanpa alarm sendiri
- Mode maintenance

SNMP, grafik trafik, RouterOS, client PPPoE, dan push notification menyusul di fase berikutnya.

## Deploy ke server (sekali jalan)

Di server Ubuntu 22.04/24.04 atau Debian 12 yang masih bersih, jalankan sebagai root:

```bash
curl -fsSL https://raw.githubusercontent.com/azizsokayasa30/nms-kalimasada/main/deploy.sh | bash
```

Script `deploy.sh` memasang PostgreSQL, Zabbix 7.0 (server, frontend, agent), Node.js, dan nginx, lalu build dan menjalankan NMS sebagai service `kalimasada-api`. Dashboard ada di port 80 dan Zabbix di port 8080.

Instal baru maupun ulang memakai tatanan folder ini:

```
/root/NMS-KALIMASADA/                            kode (frontend, backend, deploy.sh)
/root/NMS-KALIMASADA/www/                        file frontend yang dilayani nginx
/root/NMS-KALIMASADA/secrets.env                 secret deploy
/root/NMS-KALIMASADA/kalimasada-credentials.txt  ringkasan login
```

Domain bawaan adalah `nms.kalimasada-app.com` untuk dashboard dan `zabbix.kalimasada-app.com` untuk Zabbix. Buat record A kedua nama itu ke IP server NMS; record wildcard `*` milik aplikasi billing tidak perlu diubah. Begitu DNS mengarah ke server, `deploy.sh` membuat sertifikat Let's Encrypt dan mengalihkan HTTP ke HTTPS. Atur lewat `NMS_DOMAIN`, `ZABBIX_DOMAIN`, `ENABLE_HTTPS`, dan `LE_EMAIL`.

Password dibuat acak dan disimpan di `/root/NMS-KALIMASADA/kalimasada-credentials.txt`. Untuk update, jalankan ulang `sudo bash /root/NMS-KALIMASADA/deploy.sh`. Opsi lain bisa dilihat dengan `bash deploy.sh --help`.

## Menjalankan di PC ini

PostgreSQL aplikasi memakai basis data lokal di `backend/.data`. Docker belum wajib untuk membuka dashboard.

```powershell
cd backend
npm install
npm run start:dev
```

Di terminal lain:

```powershell
cd frontend
npm install
npm run dev
```

Buka http://localhost:5173

Akun awal dibaca dari `backend/.env`:

- Email: nilai `ADMIN_EMAIL`
- Password: nilai `ADMIN_PASSWORD`

Ganti keduanya sebelum dipakai di jaringan kantor.

## Menyalakan Zabbix

Zabbix yang melakukan ping. Pasang Docker Desktop, lalu dari folder proyek:

```powershell
docker compose up -d
```

Tunggu beberapa menit sampai http://localhost:8080 terbuka. API Zabbix ada di `http://127.0.0.1:8080/api_jsonrpc.php`. Login bawaan image adalah `Admin` / `zabbix`, sama dengan `ZABBIX_USER` dan `ZABBIX_PASSWORD` di `backend/.env`.

Setelah Zabbix hidup, perangkat yang disimpan akan dibuat menjadi host ICMP secara otomatis. Sampai saat itu, dashboard menampilkan pita peringatan dan status perangkat tetap UNKNOWN.

Saat berpindah dari database lokal ke PostgreSQL Docker, ubah `USE_EMBEDDED_POSTGRES=false` dan `DATABASE_URL` ke `postgresql://kalimasada:kalimasada@127.0.0.1:5432/kalimasada`.

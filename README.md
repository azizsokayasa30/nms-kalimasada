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

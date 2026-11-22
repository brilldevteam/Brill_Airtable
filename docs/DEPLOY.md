# Deploying Brill Tables to the VPS (CloudPanel + PM2)

Target: **https://airtable.brillcrew.com**, one Node.js process run by PM2. nginx (set up by CloudPanel) sits in front and handles HTTPS. No Docker, and no database server to install: the database is built in and saved to a folder.

```
Browser ──HTTPS──► nginx (CloudPanel, SSL) ──► 127.0.0.1:4000  Node (PM2 "brill-tables")
                                                  ├─ the web app (apps/web/dist)
                                                  ├─ the API (/api/…)
                                                  └─ data: ~/brill-data/{pg, files, backups}
```

---

## 1. Create the site in CloudPanel

1. **Sites → Add Site → Create a Node.js Site.**
2. Fill in:
   - **Domain:** `airtable.brillcrew.com`
   - **Node.js version:** **22**
   - **App port:** **4000**. Use a port none of your other apps use; if you pick another, use the same number in step 4.
   - **Site user / password:** CloudPanel creates a Linux user for the site. These steps assume it's called `brill`.
3. **DNS:** an `A` record for `airtable` pointing at the VPS's IP (in Cloudflare, your registrar or wherever brillcrew.com's DNS lives).
4. **SSL:** in the site, go to **SSL/TLS → Actions → New Let's Encrypt Certificate**. DNS must already point to the server.

### nginx: allow 25 MB uploads

In the site's **Vhost** tab, inside the `server { … }` block for port 443, add (or raise) this line and save:

```
client_max_body_size 30M;
```

Live updates already work through nginx: the app turns off buffering for them and keeps the connection alive.

## 2. Get the code onto the server

SSH in **as the site user**, not root:

```bash
ssh brill@your-vps-ip
```

The repository is private, so give the server read access first:
- **Recommended:** add a **deploy key**. Run `ssh-keygen -t ed25519` on the server, then add the contents of `~/.ssh/id_ed25519.pub` in GitHub under **Brill_Airtable → Settings → Deploy keys** (read-only).
- **Alternative:** clone over HTTPS with a fine-grained personal access token.

Then clone the code into its own folder, separate from the data:

```bash
cd ~
git clone git@github.com:brilldevteam/Brill_Airtable.git brill-tables
cd brill-tables
```

## 3. Install pnpm and the dependencies

Node 22 ships with Corepack, which installs the exact pnpm version this project uses:

```bash
corepack enable --install-directory ~/.local/bin
corepack prepare pnpm@11.24.0 --activate
```

```bash
pnpm install --frozen-lockfile
```

If `corepack enable` isn't allowed, use `npm i -g pnpm@11.24.0` (as root) instead.

## 4. Settings

```bash
cp .env.production.example .env.production
nano .env.production
```

Check these values:

| Setting | Value |
|---|---|
| `APP_URL` | `https://airtable.brillcrew.com` |
| `PORT` | The port from step 1 (4000) |
| `DATA_DIR` / `FILES_DIR` / `BACKUP_DIR` | Change `/home/brill/` to the site user's home folder. Keep them outside `brill-tables/` so updates never touch data. |
| `SIGNUPS` | `invite`: you create the first account, and after that people can only join through an invite. Set it to `open` only if anyone should be able to sign up. |
| `MAIL_PROVIDER` | Leave as `log` for now. Emails are written to the PM2 log and not sent. Switch to Resend later (section 9). |

Create the data folders:

```bash
mkdir -p ~/brill-data/{pg,files,backups}
```

## 5. Build and start

```bash
pnpm build
```

```bash
pm2 start ecosystem.config.cjs
```

```bash
pm2 save
```

`pm2 save` adds Brill Tables to the apps PM2 starts on boot. Your existing PM2 startup setup covers it, so there's no need to run `pm2 startup` again.

Check that it's running:

```bash
pm2 status brill-tables
```

```bash
curl -s http://127.0.0.1:4000/api/health
```

The health check should print `{"ok":true}`. Then open **https://airtable.brillcrew.com**.

## 6. First login

1. Click **Create an account** and sign up with your own email. With `SIGNUPS=invite` only this first account can sign up freely; after that the sign-in page shows "Ask your team for an invite".
2. Email confirmation links appear in the log (`pm2 logs brill-tables`) until real email is set up. Open the link from there.
3. Invite your team through **Share** (whole workspace) and clients through **Share → Only this base**. Until email sending is set up, the invite link appears in the Share dialog for you to send yourself.

Optional: to load the demo base into production, run this while the app is running:

```bash
API_URL=http://127.0.0.1:4000 DEMO_EMAIL=you@brillcrew.com DEMO_PASSWORD='your-password' pnpm seed:demo
```

## 7. Updating to a new version

```bash
cd ~/brill-tables
git pull
pnpm install --frozen-lockfile
pnpm build
pm2 reload brill-tables
```

Database changes are applied automatically when the app starts. The site is down for a few seconds during the reload.

## 8. Backups

- **Database:** the app writes a compressed snapshot every night at 02:30 (server time) to `BACKUP_DIR` as `brill-db-YYYY-MM-DD.tar.gz`, and keeps the last 14. `pm2 logs brill-tables` shows "Database backup written…".
- **Uploaded files:** the `FILES_DIR` folder. Include `~/brill-data` in your VPS or CloudPanel backups, or copy it off the server regularly. For example, with a daily cron job:

  ```bash
  rsync -a ~/brill-data/ backup-host:brill-data/
  ```

- **Restoring the database** from a snapshot:

  ```bash
  pm2 stop brill-tables
  ```

  ```bash
  pnpm --filter @brill/api restore-backup ~/brill-data/backups/brill-db-2026-11-20.tar.gz ~/brill-data/pg
  ```

  ```bash
  pm2 start brill-tables
  ```

  The current database is moved aside, not deleted.

## 9. Real emails (later)

1. Create a Resend account and verify `brillcrew.com` by adding the DNS records Resend shows you.
2. In `.env.production`:

   ```
   MAIL_PROVIDER=resend
   RESEND_API_KEY=re_…
   MAIL_FROM=Brill Tables <no-reply@brillcrew.com>
   ```

3. Restart with the new settings:

   ```bash
   pm2 restart brill-tables --update-env
   ```

From then on, sign-up confirmations, password resets, invites and automation emails reach real inboxes.

## 9b. Install it as an app, and the mobile app

Brill Tables is a **PWA** (installable web app). It ships a manifest, app icons and a service worker, so:

- **Phone:** open https://airtable.brillcrew.com in Chrome (Android) → ⋮ → *Install app*, or in Safari (iPhone) → Share → *Add to Home Screen*. It opens full-screen with its own icon.
- **Computer:** Chrome/Edge show an install icon in the address bar.
- Data is never cached on the device — the app always shows live data and needs a connection.

**Wrapping it in a store app (the “iframe” method).** The simplest, most reliable way is a WebView that opens the site *directly* (Capacitor, a Flutter/React Native WebView, or a PWA-to-store builder like PWABuilder). That needs no server change — sign-in works because the site is the page itself.

If the wrapper instead loads the site **inside an iframe** of its own page, tell the server which origin frames it, in `.env.production`:

```bash
EMBED_ORIGINS=https://app.brillcrew.com
```

then `pm2 restart brill-tables --update-env`. The app's pages then allow that origin as a frame parent (and only it), and the sign-in cookie becomes `SameSite=None; Secure; Partitioned` so it works inside the frame. Note: iPhones block cookies in cross-site iframes more strictly, which is why the direct WebView is recommended.

## 10. Day-to-day

| Task | Command |
|---|---|
| Logs | `pm2 logs brill-tables` |
| Restart | `pm2 restart brill-tables` |
| Status and memory | `pm2 status` |

## Notes and limits

- **Run one process only.** The built-in database and the live updates live inside that process, which is why the PM2 config uses `instances: 1`. Running more than one copy at once needs the hosted-Postgres step in `SAAS_PLAN.md`.
- **Capacity:** one process is comfortably enough for a team plus clients, up to tens of thousands of records. Watch memory with `pm2 status`; PM2 restarts the app if it goes over 1 GB.
- **Other PM2 apps are unaffected.** Brill Tables only uses its own port and its own folders.

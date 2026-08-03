# Code signing with Azure Trusted Signing (~$10/month)

This removes the SmartScreen "Windows protected your PC" warning **and** the
Smart App Control block, because Azure Trusted Signing is Microsoft's own
program and is trusted by Windows.

The tooling here is ready. You do the Azure account setup once (the identity
verification takes ~1–3 business days), then every build signs automatically.

---

## Part A — Azure setup (once, in the Azure portal)

1. **Azure account + subscription** — sign in at portal.azure.com, add a
   pay-as-you-go subscription.
2. **Register the provider** — Subscription → *Resource providers* → search
   `Microsoft.CodeSigning` → **Register**.
3. **Create a Trusted Signing account** — search "Trusted Signing accounts" →
   **Create** → choose a **region** (remember it) → **Basic** tier (~$9.99/mo).
4. **Create a Certificate Profile** — inside the account → *Certificate profiles*
   → **Create** → type **Public Trust** → complete **Identity Validation**
   (individual: your ID; business: company docs). ⏳ **Approval takes 1–3 days.**
5. **Wait** until the identity validation shows **Completed/Approved**.

## Part B — Credentials for automated signing (once)

6. **App registration (service principal)** — Microsoft Entra ID → *App
   registrations* → **New registration**. Note the **Application (client) ID**
   and **Directory (tenant) ID**.
7. **Client secret** — that app → *Certificates & secrets* → **New client
   secret** → copy the **Value** (shown once).
8. **Grant signing role** — your Trusted Signing account → *Access control (IAM)*
   → **Add role assignment** → role **“Trusted Signing Certificate Profile
   Signer”** → assign to the app registration from step 6.

## Part C — Configure this repo (once)

9. Copy the template and fill it in:
   ```
   copy signing\metadata.example.json signing\metadata.json
   ```
   ```json
   {
     "Endpoint": "https://<REGION>.codesigning.azure.net/",
     "CodeSigningAccountName": "<your account name>",
     "CertificateProfileName": "<your profile name>"
   }
   ```
   Region → endpoint examples: East US = `eus`, West US 2 = `wus2`,
   West Central US = `wcus`, North Europe = `neu`, West Europe = `weu`
   (e.g. East US → `https://eus.codesigning.azure.net/`).

10. Set the service-principal env vars (keep the secret private):
    ```powershell
    $env:AZURE_TENANT_ID   = "<directory (tenant) id>"
    $env:AZURE_CLIENT_ID   = "<application (client) id>"
    $env:AZURE_CLIENT_SECRET = "<client secret value>"
    ```

## Part D — Build signed

```
npm run build:all
```
This builds the agent, **signs it**, compiles the installer, and **signs the
installer** — producing a signed `release/AegisSetup.exe`. Then commit/push so
Railway serves the signed installer (or upload it in the dashboard).

> If signing isn't configured yet, `build:all` still runs and just skips the
> signing steps (unsigned build), so nothing breaks.

**Verify a signature:**
```powershell
Get-AuthenticodeSignature release\AegisSetup.exe | Format-List Status, SignerCertificate
```
`Status` should be `Valid` and the signer should be **your** name/company.

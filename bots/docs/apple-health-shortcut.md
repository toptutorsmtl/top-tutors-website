# Apple Health → Coach: the iPhone Shortcut

This guide is for the iPhone setup. MacroFactor writes to Apple Health, and this Shortcut reads today's totals from Health and POSTs them to Coach's server. An automation runs the Shortcut every time you close MacroFactor.

**You need:**
- Coach's server URL, e.g. `https://coach-buddy-production.up.railway.app` (from the deploy step in `../README.md`)
- Your `INGEST_KEY` (the secret from your env vars)

The menu names below match iOS 17/18. If a label is slightly different on your phone, search for the action by name in the action search bar.

---

## Step 0: Let MacroFactor write to Apple Health

1. In **MacroFactor**, open the settings and find the Apple Health integration (it's under integrations or data sources). Turn on **export / write** for **nutrition** and **weight**.
2. Open iOS **Settings → Health → Data Access & Devices → MacroFactor**. Make sure MacroFactor is allowed to **write** Dietary Energy, Protein, Carbohydrates, Total Fat, Fiber, and Weight.
3. Log something in MacroFactor, then open the **Health** app → Browse → Nutrition → Dietary Energy. You should see it there. If you don't, fix this first. Nothing downstream will work without it.

---

## Step 1: Build the "Coach Sync" shortcut

Open **Shortcuts**, tap **+**, and name the shortcut **Coach Sync**. Add the following actions in order.

### 1a. Today's date

| # | Action | Settings |
|---|---|---|
| 1 | **Date** | Current Date |
| 2 | **Format Date** | Date Format: **Custom**, Format String: `yyyy-MM-dd` |
| 3 | **Set Variable** | Name: `Today` (input: Formatted Date) |

### 1b. Calories, then the same block for each macro

For calories, add these three actions:

| # | Action | Settings |
|---|---|---|
| 4 | **Find Health Samples** | Filters: **Type** is **Dietary Energy** · **Start Date** is **today** · *(recommended)* **Source** is **MacroFactor**. Leave Sort and Limit off. |
| 5 | **Calculate Statistics** | **Sum** of Health Samples |
| 6 | **Set Variable** | Name: `Calories` (input: Statistics Result) |

Repeat the same three actions once for each row below. The quickest way is to long-press the Find Health Samples action → **Duplicate**, then duplicate the other two the same way and change the settings.

| Type in Find Health Samples | Variable name |
|---|---|
| Protein | `Protein` |
| Carbohydrates | `Carbs` |
| Total Fat | `Fat` |
| Fiber | `Fiber` |

The **Source is MacroFactor** filter keeps other apps that write nutrition from double-counting.

### 1c. Steps

| # | Action | Settings |
|---|---|---|
| | **Find Health Samples** | **Type** is **Steps** · **Start Date** is **today** · **Group By: Day** |
| | **Calculate Statistics** | **Sum** of Health Samples |
| | **Set Variable** | `Steps` |

If you wear an Apple Watch and Coach shows about double the steps that the Health app shows, add a filter **Source is [your iPhone's name]**.

### 1d. Latest weigh-in

| # | Action | Settings |
|---|---|---|
| | **Find Health Samples** | **Type** is **Weight** · **Sort by: Start Date** · **Order: Latest First** · **Limit: on, 1** |
| | **Get Details of Health Sample** | **Value** |
| | **Set Variable** | `Weight` |
| | **Get Details of Health Sample** | **Unit** (tap the input and pick the *Health Samples* output from the Find action, not Weight) |
| | **Set Variable** | `WeightUnit` |
| | **Get Details of Health Sample** | **Start Date** (input: the Health Samples again) |
| | **Format Date** | Custom: `yyyy-MM-dd` |
| | **Set Variable** | `WeightDate` |

This sends your most recent weigh-in together with its own date. The server files it under the right day, so a weigh-in from yesterday morning stays on yesterday's row.

### 1e. Send it to Coach

Add **Get Contents of URL**:

- **URL:** `https://YOUR-SERVER/ingest/health`
- Tap **Show More**:
  - **Method:** `POST`
  - **Headers:** add one header: key `X-Ingest-Key`, value = your `INGEST_KEY`
  - **Request Body:** `JSON`. Add these fields, every one of type **Text**, with each value set to the variable of the same name:

| Key | Value (variable) |
|---|---|
| `date` | Today |
| `calories` | Calories |
| `protein_g` | Protein |
| `carbs_g` | Carbs |
| `fat_g` | Fat |
| `fiber_g` | Fiber |
| `steps` | Steps |
| `weight` | Weight |
| `weight_unit` | WeightUnit |
| `weight_date` | WeightDate |

Using **Text** for everything is deliberate. The server accepts `2150`, `2 150,5`, `82,4`, or `181.2 lb`, so iPhone language and number format don't matter.

### 1f. First test

1. Add one more JSON field: `test`, type **Boolean**, value **true**.
2. Tap ▶︎ to run the shortcut. iOS asks for Health read permission (tap **Allow** / turn all on), then asks to connect to your server (tap **Allow**).
3. Coach should message you in Telegram: **"✅ Health sync received for 2026-11-12: 82.2 kg, 2140 kcal, P 168g, …"**
4. Delete the `test` field. Normal syncs stay silent. Coach only confirms test runs and the very first sync.

If it fails, add a **Show Result** action after Get Contents of URL and run it again. The server's reply explains what went wrong:
- `401`: the key is wrong.
- `400`: the body isn't valid. The message says why.

---

## Step 2: Automations (so you never think about it)

Shortcuts app → **Automation** tab → **+**.

### A. When MacroFactor closes (main trigger)

1. **App** → choose **MacroFactor** → check **Is Closed** and uncheck Is Opened.
2. Select **Run Immediately** and turn **Notify When Run** off.
3. Action: **Run Shortcut** → **Coach Sync**.

Your phone is unlocked at that moment and you've just changed data, so this trigger catches nearly everything.

### B. Nightly backup

1. **Time of Day** → **21:30**, **Daily**.
2. Select **Run Immediately**.
3. Action: **Run Shortcut** → **Coach Sync**.

This catches a weigh-in or a meal you logged without closing the app. iOS won't let anything read Health while the phone is locked, so if the phone happens to be locked at 21:30 this run is skipped. That's fine: the next time you close MacroFactor, it syncs.

---

## How it behaves

- Each sync sends **today's running totals**. A later sync overwrites earlier totals for that day, and empty or 0 values never erase data that's already there.
- If you edit **yesterday's** log after midnight, today's sync won't send it. Send Coach a screenshot of that day, or ask Coach to fix the number.
- If no sync arrives for 36 hours, Coach sends you **one** message about it. `/sync` shows when the last sync came in.

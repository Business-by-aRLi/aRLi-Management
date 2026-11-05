# aRLi Management

מערכת פנימית לניהול העסק של מירי וריקי: פרויקטים, הכנסות והוצאות, מאזן בין השותפות, שעות, משימות ויומן.

## בסיס הנתונים (Supabase: `aRLi-Management`)

המיגרציות נמצאות ב-`supabase/migrations`.

| טבלה | תפקיד |
| --- | --- |
| `partners` | מירי וריקי. חשבון משתמש מתחבר לשותפה לפי המייל |
| `clients`, `projects` | לקוחות ופרויקטים (סוג: business / learning / client) |
| `project_profit_shares` | אחוזי הרווח של כל שותפה בכל פרויקט (ברירת מחדל: חצי-חצי) |
| `income`, `expenses` | הכנסות והוצאות. מי קיבלה, מי שילמה, ואסמכתה |
| `recurring_costs` | עלויות שוטפות |
| `settlements` | העברות כסף בין השותפות |
| `time_entries`, `work_plans`, `tasks` | שעות, תוכניות עבודה ומשימות |

תצוגות: `project_financials` (רווח לכל פרויקט), `partner_balances` (מי חייבת למי), `business_account_balance`.

כלל המאזן: רווח פרויקט = הכנסות − הוצאות, ומתחלק לפי האחוזים של אותו פרויקט. הוצאות שלא שייכות לפרויקט מתחלקות חצי-חצי.
`net_position` חיובי פירושו שהשותפה מחזיקה יותר מהחלק שלה וחייבת את ההפרש.

הרשאות: כל הטבלאות מוגנות ב-RLS. רק משתמש מחובר שמקושר לשותפה רואה נתונים. קבלות נשמרות בדלי פרטי `receipts`.

## בוט טלגרם (`supabase/functions/telegram-bot`)

הבוט רץ כ-Edge Function ב-Supabase, ומשתמש ב-Gemini להבנת טקסט, צילומי חשבוניות והודעות קוליות.

- סיקרטים: `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`. אפשר גם `GEMINI_MODEL` (ברירת מחדל `gemini-flash-latest`).
- כל שותפה מתחברת פעם אחת עם קוד חיבור אישי (`partners.telegram_link_code`).
- `?action=setup` רושם את ה-webhook בטלגרם.
- `?action=cron` רץ כל דקה (pg_cron) ושולח: תזכורות, התראה שעה לפני פגישה, דדליינים של משימות מ-08:00, וסיכום שבועי בימי ראשון ב-09:00.

### חיבור Gmail לחשבוניות

כל שותפה יכולה לחבר את תיבת ה-Gmail שלה (קריאה בלבד). אחרי החיבור אפשר לבקש מהבוט למשל "תמצאי את החשבוניות של Vercel מאוקטובר". הבוט מחפש, קורא את ה-PDF המצורף (או את גוף המייל), מציג סיכום, ורושם הוצאה רק אחרי אישור. הקובץ נשמר בדלי `receipts` תחת `gmail/`, ו-`expenses.gmail_message_id` מונע רישום כפול.

- סיקרטים: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (לקוח OAuth מסוג Web application ב-Google Cloud, עם Gmail API מופעל).
- Redirect URI מורשה: `https://yeapgpdxflrcttjxfrgl.supabase.co/functions/v1/telegram-bot/gmail/callback`
- את מסך ההסכמה (OAuth consent screen) כדאי להעביר למצב "In production". במצב Testing ההרשאה פגה אחרי 7 ימים.
- טבלאות: `gmail_accounts` (טוקנים, רק ה-service role ניגש), `gmail_oauth_states` (קישורי חיבור, תקפים 15 דקות).

## העלאת מסמך באתר (`supabase/functions/parse-document`)

במסך הכספים, "העלאת מסמך": מעלים תמונה או PDF של חשבונית או קבלה. הקובץ נשמר בדלי `receipts`, והפונקציה `parse-document` קוראת אותו עם Gemini ומחזירה הצעה: הוצאה או הכנסה, סכום, מטבע, תאריך, ספק או לקוח, מספר מסמך, קטגוריה, פרויקט משוער ורשומות שאולי כפולות. היא לא רושמת כלום. האתר מציג טופס מלא מראש, והשותפה מאשרת או מתקנת לפני השמירה. אם מבטלים, הקובץ נמחק.

- הפונקציה מורידה את הקובץ עם ה-JWT של המשתמשת, כך שה-RLS של הדלי (`is_partner`) קובע הרשאה. פריסה עם `verify_jwt` פעיל.
- סיקרט: `GEMINI_API_KEY` (אותו של הבוט). קוד Gemini משותף ב-`supabase/functions/_shared/gemini.ts`.
- מיגרציה `20261105233000_income_receipts.sql` מוסיפה ל-`income` את `receipt_path` ו-`reference`.

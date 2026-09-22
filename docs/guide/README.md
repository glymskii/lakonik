# Памятка сотрудника (PDF)

`guide.html` → PDF через headless Chrome; скриншоты в `screens/` (не в git) снимаются в симуляторе iPhone 17 под демо-пользователем
`asel.nurlanova@orbita.kz` (данные: `scripts/seed-showcase.ts` + `scripts/seed-guide.ts` — встреча «Расшифровка готова» с подсказками спикеров).

```bash
cd docs/guide && "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$PWD/ADV Meetings — памятка сотрудника.pdf" "file://$PWD/guide.html"
```

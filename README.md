# Установка

1. Откройте PowerShell.
2. Выполните команду:

```powershell
npx pg-data-upper install
```

Готово. Файлы появятся в папке `pg-data-upper-kit`.

Дальше в папке комплекта запустите Windows-установку:

```powershell
powershell -ExecutionPolicy Bypass -File .\offline-setup.ps1
```

После установки Ollama нажмите `Ctrl+C`, отмените выполнение скрипта и запустите
эту же команду еще раз. При повторном запуске поставится локальная модель.

Запуск чата:

```powershell
powershell -ExecutionPolicy Bypass -File .\start-opencode.ps1
```

Нужная модель будет доступна в меню `More`. После входа в чат с моделью
введите `/clear`, чтобы обнулить контекст.

Нужна другая папка:

```powershell
npx pg-data-upper install --dir C:\exam-kit
```

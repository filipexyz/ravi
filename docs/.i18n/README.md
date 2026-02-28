# i18n — Translation Pipeline

This directory will hold translation assets for pt-BR and future locales.

## Planned structure

```
.i18n/
├── glossary.csv         # Term glossary (source → target)
├── translation-memory/  # TMX files per locale
└── README.md
```

## Pipeline (not yet implemented)

1. Extract translatable strings from `docs/**/*.md`
2. Apply glossary for consistent terminology
3. Generate `docs/pt-BR/` mirror with translated content
4. Validate links and frontmatter in translated pages

/**
 * UI translation catalog (app interface strings).
 *
 * IMPORTANT — this is NOT the conversion-language list. `constants/languages.ts`
 * lists the 27 languages a *book* can be converted into. This file lists the
 * languages the *app UI itself* is translated into. Book titles and chapter
 * names are user content and are NEVER translated — only the surrounding UI is.
 *
 * Structure: keyed by string, each entry carries every language inline. `en` is
 * required on every entry and is the fallback; other languages are optional and
 * fall back to `en` at lookup time (see i18n/index.ts). Adding a screen = append
 * its keys here (all languages together) and call t('key') in the screen.
 *
 * Rollout order follows real device-locale usage (PostHog): zh, es, fr, ru, ja
 * lead. RTL languages (ar, he) are excluded for now — they need layout mirroring
 * and are a separate, tested pass. Adding a language later = add its code to
 * UI_LANGUAGE_CODES + fill entries, then ship via `eas update` (JS-only).
 *
 * Interpolation: use {name} placeholders and pass params to t().
 */

export type LangCode = 'en' | 'es' | 'fr' | 'de' | 'ja' | 'zh' | 'ru';

/** A single translatable string across all languages. `en` is mandatory. */
export type Entry = Partial<Record<LangCode, string>> & { en: string };

/** UI-translated language codes, in rollout priority order (en first = base). */
export const UI_LANGUAGE_CODES: LangCode[] = ['en', 'es', 'fr', 'de', 'ja', 'zh', 'ru'];

export const catalog: Record<string, Entry> = {
  // ── Generic actions / status ──────────────────────────────────────────────
  'common.cancel':  { en: 'Cancel',    es: 'Cancelar',   fr: 'Annuler',   de: 'Abbrechen',        ja: 'キャンセル', zh: '取消', ru: 'Отмена' },
  'common.save':    { en: 'Save',      es: 'Guardar',    fr: 'Enregistrer', de: 'Speichern',      ja: '保存',       zh: '保存', ru: 'Сохранить' },
  'common.done':    { en: 'Done',      es: 'Listo',      fr: 'Terminé',   de: 'Fertig',           ja: '完了',       zh: '完成', ru: 'Готово' },
  'common.retry':   { en: 'Retry',     es: 'Reintentar', fr: 'Réessayer', de: 'Erneut versuchen', ja: '再試行',     zh: '重试', ru: 'Повторить' },
  'common.loading': { en: 'Loading…',  es: 'Cargando…',  fr: 'Chargement…', de: 'Wird geladen…',  ja: '読み込み中…', zh: '加载中…', ru: 'Загрузка…' },
  'common.continue': { en: 'Continue', es: 'Continuar', fr: 'Continuer', de: 'Weiter', ja: '続ける', zh: '继续', ru: 'Продолжить' },
  'common.clear_search': { en: 'Clear search', es: 'Borrar búsqueda', fr: 'Effacer la recherche', de: 'Suche löschen', ja: '検索をクリア', zh: '清除搜索', ru: 'Очистить поиск' },

  // ── Navigation: tab bar + stack header titles (visible on nearly every screen) ──
  'nav.discover':        { en: 'Discover',        es: 'Descubrir',            fr: 'Découvrir',             de: 'Entdecken',        ja: '見つける',       zh: '发现',     ru: 'Обзор' },
  'nav.library':         { en: 'Library',         es: 'Biblioteca',           fr: 'Bibliothèque',          de: 'Bibliothek',       ja: 'ライブラリ',     zh: '书库',     ru: 'Библиотека' },
  'nav.profile':         { en: 'Profile',         es: 'Perfil',               fr: 'Profil',                de: 'Profil',           ja: 'プロフィール',   zh: '我的',     ru: 'Профиль' },
  'nav.upload':          { en: 'Upload Book',      es: 'Subir libro',          fr: 'Importer un livre',     de: 'Buch importieren', ja: '本を取り込む',   zh: '上传书籍', ru: 'Загрузить книгу' },
  'nav.book_details':    { en: 'Book details',     es: 'Detalles del libro',   fr: 'Détails du livre',      de: 'Buchdetails',      ja: '本の詳細',       zh: '书籍详情', ru: 'О книге' },
  'nav.book_language':   { en: 'Book Language',    es: 'Idioma del libro',     fr: 'Langue du livre',       de: 'Buchsprache',      ja: '本の言語',       zh: '书籍语言', ru: 'Язык книги' },
  'nav.review_chapters': { en: 'Review Chapters',  es: 'Revisar capítulos',    fr: 'Vérifier les chapitres', de: 'Kapitel prüfen',  ja: '章を確認',       zh: '检查章节', ru: 'Проверить главы' },
  'nav.select_voice':    { en: 'Select Voice',     es: 'Elegir voz',           fr: 'Choisir la voix',       de: 'Stimme wählen',    ja: '音声を選択',     zh: '选择语音', ru: 'Выбрать голос' },
  'nav.now_playing':     { en: 'Now Playing',      es: 'Reproduciendo',        fr: 'Lecture en cours',      de: 'Wird abgespielt',  ja: '再生中',         zh: '正在播放', ru: 'Сейчас играет' },
  'nav.settings':        { en: 'Settings',         es: 'Ajustes',              fr: 'Réglages',              de: 'Einstellungen',    ja: '設定',           zh: '设置',     ru: 'Настройки' },

  // ── Library (empty state = first screen a new user sees) ───────────────────
  'library.empty_title':    { en: 'Your library is empty', es: 'Tu biblioteca está vacía', fr: 'Votre bibliothèque est vide', de: 'Deine Bibliothek ist leer', ja: 'ライブラリは空です', zh: '你的书库是空的', ru: 'Ваша библиотека пуста' },
  'library.empty_subtitle': { en: 'EbookVoice turns EPUBs you already own into beautifully narrated audiobooks.', es: 'EbookVoice convierte los EPUB que ya tienes en audiolibros bellamente narrados.', fr: 'EbookVoice transforme les EPUB que vous possédez déjà en livres audio superbement narrés.', de: 'EbookVoice verwandelt EPUBs, die dir bereits gehören, in wunderschön vertonte Hörbücher.', ja: 'EbookVoiceは、お持ちのEPUBを美しく朗読されたオーディオブックに変換します。', zh: 'EbookVoice 将你已拥有的 EPUB 转换为优美朗读的有声书。', ru: 'EbookVoice превращает EPUB, которые у вас уже есть, в красиво озвученные аудиокниги.' },
  'library.find_book':      { en: 'Find a Book',  es: 'Buscar un libro', fr: 'Trouver un livre', de: 'Buch finden',      ja: '本を探す',        zh: '查找书籍', ru: 'Найти книгу' },
  'library.upload_epub':    { en: 'Upload EPUB',  es: 'Subir EPUB',      fr: 'Importer un EPUB', de: 'EPUB importieren', ja: 'EPUBを取り込む',  zh: '上传 EPUB', ru: 'Загрузить книгу' },

  // ── Settings (manual language picker) ─────────────────────────────────────
  'settings.title':           { en: 'Settings',      es: 'Ajustes',              fr: 'Réglages',              de: 'Einstellungen',  ja: '設定',           zh: '设置',       ru: 'Настройки' },
  'settings.language':        { en: 'App Language',  es: 'Idioma de la app',     fr: "Langue de l'app",       de: 'App-Sprache',    ja: 'アプリの言語',   zh: '应用语言',   ru: 'Язык приложения' },
  'settings.language_choose': { en: 'Choose language', es: 'Elegir idioma',      fr: 'Choisir la langue',     de: 'Sprache wählen', ja: '言語を選択',     zh: '选择语言',   ru: 'Выбрать язык' },
  'settings.language_system': { en: 'Match device language', es: 'Idioma del dispositivo', fr: "Langue de l'appareil", de: 'Gerätesprache', ja: '端末の言語に合わせる', zh: '跟随系统语言', ru: 'Язык устройства' },

  // ── Discover / BookSearch ─────────────────────────────────────────────────
  'discover.search_placeholder': { en: 'Search classic books…', es: 'Buscar libros clásicos…', fr: 'Rechercher des livres classiques…', de: 'Klassische Bücher suchen…', ja: 'クラシック作品を検索…', zh: '搜索经典书籍…', ru: 'Искать классические книги…' },
  'discover.cat_fiction':   { en: 'Fiction',   es: 'Ficción',   fr: 'Fiction',   de: 'Belletristik',  ja: 'フィクション', zh: '小说', ru: 'Проза' },
  'discover.cat_romance':   { en: 'Romance',   es: 'Romance',   fr: 'Romance',   de: 'Liebe',         ja: 'ロマンス',     zh: '爱情', ru: 'Романтика' },
  'discover.cat_religion':  { en: 'Religion',  es: 'Religión',  fr: 'Religion',  de: 'Religion',      ja: '宗教',         zh: '宗教', ru: 'Религия' },
  'discover.cat_education': { en: 'Education', es: 'Educación', fr: 'Éducation', de: 'Bildung',       ja: '教育',         zh: '教育', ru: 'Образование' },
  'discover.cat_history':   { en: 'History',   es: 'Historia',  fr: 'Histoire',  de: 'Geschichte',    ja: '歴史',         zh: '历史', ru: 'История' },
  'discover.cat_adventure': { en: 'Adventure', es: 'Aventura',  fr: 'Aventure',  de: 'Abenteuer',     ja: '冒険',         zh: '冒险', ru: 'Приключения' },
  'discover.cat_mystery':   { en: 'Mystery',   es: 'Misterio',  fr: 'Mystère',   de: 'Krimi',         ja: 'ミステリー',   zh: '推理', ru: 'Детектив' },
  'discover.cat_children':  { en: 'Children',  es: 'Infantil',  fr: 'Enfants',   de: 'Kinder',        ja: '児童書',       zh: '儿童', ru: 'Детям' },
  'discover.cat_poetry':    { en: 'Poetry',    es: 'Poesía',    fr: 'Poésie',    de: 'Poesie',        ja: '詩',           zh: '诗歌', ru: 'Поэзия' },
  'discover.cat_science':   { en: 'Science',   es: 'Ciencia',   fr: 'Science',   de: 'Wissenschaft',  ja: '科学',         zh: '科学', ru: 'Наука' },
  'discover.no_results':    { en: 'No books found. Try another title or author.', es: 'No se encontraron libros. Prueba con otro título o autor.', fr: 'Aucun livre trouvé. Essayez un autre titre ou auteur.', de: 'Keine Bücher gefunden. Versuche einen anderen Titel oder Autor.', ja: '本が見つかりません。別のタイトルや著者でお試しください。', zh: '未找到书籍。请尝试其他书名或作者。', ru: 'Книги не найдены. Попробуйте другое название или автора.' },
  'discover.no_category':   { en: 'No books in this category right now.', es: 'No hay libros en esta categoría por ahora.', fr: 'Aucun livre dans cette catégorie pour le moment.', de: 'Momentan keine Bücher in dieser Kategorie.', ja: '現在、このカテゴリには本がありません。', zh: '目前该分类下暂无书籍。', ru: 'Сейчас в этой категории нет книг.' },
  'discover.unknown_author':{ en: 'Unknown author', es: 'Autor desconocido', fr: 'Auteur inconnu', de: 'Unbekannter Autor', ja: '著者不明', zh: '作者不详', ru: 'Автор неизвестен' },
  'discover.announce_none': { en: 'No books found', es: 'No se encontraron libros', fr: 'Aucun livre trouvé', de: 'Keine Bücher gefunden', ja: '本が見つかりません', zh: '未找到书籍', ru: 'Книги не найдены' },
  'discover.announce_count':{ en: '{count} books found', es: '{count} libros encontrados', fr: '{count} livres trouvés', de: '{count} Bücher gefunden', ja: '{count}件の本が見つかりました', zh: '找到 {count} 本书', ru: 'Найдено книг: {count}' },
  'discover.a11y_upload':      { en: 'Upload an EPUB', es: 'Subir un EPUB', fr: 'Importer un EPUB', de: 'EPUB importieren', ja: 'EPUBを取り込む', zh: '上传 EPUB', ru: 'Загрузить EPUB' },
  'discover.a11y_upload_hint': { en: 'Pick an EPUB file from your device to convert', es: 'Elige un archivo EPUB de tu dispositivo para convertir', fr: 'Choisissez un fichier EPUB sur votre appareil à convertir', de: 'Wähle eine EPUB-Datei von deinem Gerät zum Umwandeln', ja: '変換するEPUBファイルを端末から選択', zh: '从你的设备选择要转换的 EPUB 文件', ru: 'Выберите файл EPUB на устройстве для конвертации' },
  'discover.a11y_search':      { en: 'Search for a book', es: 'Buscar un libro', fr: 'Rechercher un livre', de: 'Nach einem Buch suchen', ja: '本を検索', zh: '搜索书籍', ru: 'Искать книгу' },
  'discover.a11y_clear':       { en: 'Clear search', es: 'Borrar búsqueda', fr: 'Effacer la recherche', de: 'Suche löschen', ja: '検索をクリア', zh: '清除搜索', ru: 'Очистить поиск' },
  'discover.a11y_category':    { en: '{label} category', es: 'Categoría {label}', fr: 'Catégorie {label}', de: 'Kategorie {label}', ja: '{label} カテゴリ', zh: '{label} 分类', ru: 'Категория {label}' },

  // ── LanguageSelection (which language is the book in?) ─────────────────────
  'lang.title':    { en: 'What language is the book?', es: '¿En qué idioma está el libro?', fr: 'Dans quelle langue est le livre ?', de: 'In welcher Sprache ist das Buch?', ja: '本の言語は何ですか？', zh: '这本书是什么语言？', ru: 'На каком языке книга?' },
  'lang.subtitle': { en: "We'll only show narrators for this language.", es: 'Solo mostraremos narradores para este idioma.', fr: "Nous n'afficherons que les narrateurs pour cette langue.", de: 'Wir zeigen nur Sprecher für diese Sprache.', ja: 'この言語のナレーターのみ表示します。', zh: '我们只会显示该语言的旁白。', ru: 'Мы покажем только дикторов для этого языка.' },
  'lang.unsupported_banner': { en: "This book declares a language we don't have voices for yet ({lang}). Pick the closest match below.", es: 'Este libro declara un idioma para el que aún no tenemos voces ({lang}). Elige la opción más cercana abajo.', fr: "Ce livre déclare une langue pour laquelle nous n'avons pas encore de voix ({lang}). Choisissez l'option la plus proche ci-dessous.", de: 'Dieses Buch gibt eine Sprache an, für die wir noch keine Stimmen haben ({lang}). Wähle unten die passendste Option.', ja: 'この本は、まだ音声がない言語（{lang}）を指定しています。下から最も近いものを選んでください。', zh: '本书声明的语言我们暂无对应语音（{lang}）。请在下方选择最接近的语言。', ru: 'В этой книге указан язык, для которого у нас пока нет голосов ({lang}). Выберите ближайший вариант ниже.' },
  'lang.search_placeholder': { en: 'Search languages', es: 'Buscar idiomas', fr: 'Rechercher des langues', de: 'Sprachen suchen', ja: '言語を検索', zh: '搜索语言', ru: 'Искать языки' },
  'lang.voices_available': { en: '{count} voices available', es: '{count} voces disponibles', fr: '{count} voix disponibles', de: '{count} Stimmen verfügbar', ja: '{count}件の音声が利用可能', zh: '{count} 个可用语音', ru: 'Доступно голосов: {count}' },
  'lang.voices_loading': { en: 'Loading voices…', es: 'Cargando voces…', fr: 'Chargement des voix…', de: 'Stimmen werden geladen…', ja: '音声を読み込み中…', zh: '正在加载语音…', ru: 'Загрузка голосов…' },
  'lang.no_voices': { en: 'No voices available', es: 'No hay voces disponibles', fr: 'Aucune voix disponible', de: 'Keine Stimmen verfügbar', ja: '利用可能な音声がありません', zh: '暂无可用语音', ru: 'Нет доступных голосов' },
  'lang.no_match': { en: 'No languages match "{query}"', es: 'Ningún idioma coincide con "{query}"', fr: 'Aucune langue ne correspond à "{query}"', de: 'Keine Sprache passt zu „{query}"', ja: '「{query}」に一致する言語はありません', zh: '没有与"{query}"匹配的语言', ru: 'Нет языков, соответствующих «{query}»' },
  'lang.continue_hint': { en: 'Confirms the book language and continues to chapter review', es: 'Confirma el idioma del libro y continúa a la revisión de capítulos', fr: 'Confirme la langue du livre et passe à la vérification des chapitres', de: 'Bestätigt die Buchsprache und geht weiter zur Kapitelprüfung', ja: '本の言語を確定し、章の確認へ進みます', zh: '确认书籍语言并继续到章节检查', ru: 'Подтверждает язык книги и переходит к проверке глав' },
};

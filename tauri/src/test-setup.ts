// vitest 跑在 Node 裡，`navigator.language` 是 en-US：固定成繁中，斷言才與介面原文一致。
import { setLangForTest } from "./i18n";

setLangForTest("zh-TW");

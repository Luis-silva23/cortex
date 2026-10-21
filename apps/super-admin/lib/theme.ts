// Mesmo esquema de tema do Admin Web (apps/admin-web/lib/theme.ts). Módulo NÃO-cliente: o layout raiz (server
// component) precisa do script inline como valor.

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'ln-theme';

// Roda ANTES da pintura (inline no <head>): aplica a classe `dark` conforme a preferência salva ou, em "Automático",
// conforme o sistema operacional. Os tokens `.dark` de globals.css existiam, mas nada aplicava a classe.
export const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m!=='light'&&m!=='dark'&&m!=='system'){m='system';}var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

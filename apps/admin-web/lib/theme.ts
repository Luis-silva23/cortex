// Constantes de tema em módulo NÃO-cliente: o layout raiz (server component)
// precisa do script inline como valor; exportá-lo de um arquivo 'use client'
// o transformaria numa referência de cliente inutilizável no servidor.

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'ln-theme';

// Roda ANTES da pintura (inline no <head>): aplica a classe `dark` conforme a
// preferência salva ou, em "Automático", conforme o sistema operacional —
// sem isto a página piscaria clara antes do React hidratar.
export const THEME_INIT_SCRIPT = `(function(){try{var m=localStorage.getItem('${THEME_STORAGE_KEY}');if(m!=='light'&&m!=='dark'&&m!=='system'){m='system';}var d=m==='dark'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideHttpClient, withFetch } from '@angular/common/http';

// Роутера нет: приложение одностраничное, а ссылки на схему живут в хеше (#s=…, #doc=…)
// и разбираются PersistenceService. Роутер перехватывал hashchange и возвращал хеш в адрес.
export const appConfig: ApplicationConfig = {
  providers: [provideBrowserGlobalErrorListeners(), provideHttpClient(withFetch())],
};

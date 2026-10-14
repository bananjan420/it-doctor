-- Услуги: ими управляет владелец из админки, сайт берёт их из базы.
--
-- Картинка хранится прямо в строке (data:image/...) — так не нужен отдельный
-- файловый сервис, а админка может загружать картинки с телефона.

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  price text,
  price_value integer,
  icon text,
  image text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint services_title_not_empty check (length(btrim(title)) > 0)
);

-- Быстрая выборка для сайта: только активные, в заданном порядке.
create index if not exists services_active_order_idx
  on public.services (is_active, sort_order, created_at);

-- Обновляем метку времени при изменении.
create or replace function public.touch_services_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists services_touch_updated_at on public.services;

create trigger services_touch_updated_at
  before update on public.services
  for each row execute function public.touch_services_updated_at();

-- Доступ только через серверный ключ: у публичного ключа прав нет.
alter table public.services enable row level security;

-- Начальный список: переносим услуги, которые сейчас зашиты в сайте.
insert into public.services (title, description, price, price_value, icon, image, sort_order, is_active)
select * from (values
  ('Диагностика',
   'Определим причину неисправности и заранее согласуем стоимость ремонта.',
   '500 руб.', 500, 'fas fa-stethoscope',
   'assets/services/service-diagnostics.webp', 10, true),
  ('Чистка от пыли',
   'Глубокая чистка системы охлаждения системного блока или ноутбука.',
   '1 500 руб.', 1500, 'fas fa-fan',
   'assets/services/service-cleaning.webp', 20, true),
  ('Замена термопасты',
   'Обновим термоинтерфейс и снизим рабочую температуру устройства.',
   '1 000 руб.', 1000, 'fas fa-temperature-low',
   'assets/services/service-thermal-paste.webp', 30, true),
  ('Установка Windows или ПО',
   'Установим систему, драйверы и необходимые программы, выполним настройку.',
   '3 500 руб.', 3500, 'fab fa-windows',
   'assets/services/service-windows.webp', 40, true),
  ('Замена экрана на телефоне',
   'Аккуратно заменим повреждённый дисплей и проверим работу сенсора.',
   'от 500 руб.', 500, 'fas fa-mobile-alt',
   'assets/services/service-phone-screen.webp', 50, true),
  ('Замена аккумулятора',
   'Установим новый аккумулятор в телефон или ноутбук и проверим зарядку.',
   'от 5 000 руб.', 5000, 'fas fa-battery-full',
   'assets/services/service-battery.webp', 60, true),
  ('Восстановление данных',
   'Восстановим документы, фотографии и другие файлы с повреждённого диска.',
   'от 2 000 руб.', 2000, 'fas fa-hdd',
   'assets/services/service-data-recovery.webp', 70, true),
  ('Сборка и настройка ПК под ключ',
   'Подберём комплектующие, соберём компьютер и настроим систему.',
   'от 6 000 руб.', 6000, 'fas fa-desktop',
   'assets/services/service-pc-build.webp', 80, true)
) as seed(title, description, price, price_value, icon, image, sort_order, is_active)
where not exists (select 1 from public.services);

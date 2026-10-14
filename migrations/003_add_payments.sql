-- Онлайн-оплата через ЮKassa.
--
-- Оплата хранится прямо в заявке: платёж один на заявку, отдельная таблица
-- не нужна. Статус оплаты полностью независим от статуса ремонта (status):
-- они не влияют друг на друга.
--
-- Сумма платежа фиксируется на сервере по каталогу услуг и записывается в
-- payment_amount. Клиент её не передаёт и не может изменить.

-- --- 1. Услуги: признак «цена от» -----------------------------------------
--
-- Для услуг с ценой «от» оплата недоступна, поэтому признак должен храниться
-- явно, а не выводиться из текста цены.
alter table public.services
  add column if not exists price_is_from boolean not null default false;

-- Отмечаем уже существующие услуги с ценой «от».
update public.services
   set price_is_from = true
 where btrim(lower(price)) like 'от%';

-- --- 2. Заявки: связь с услугой и данные оплаты ---------------------------

alter table public.leads
  add column if not exists service_id uuid;

alter table public.leads
  add column if not exists payment_id text;

alter table public.leads
  add column if not exists payment_status text;

alter table public.leads
  add column if not exists payment_amount integer;

alter table public.leads
  add column if not exists paid_at timestamptz;

alter table public.leads
  add column if not exists payment_confirmed_at timestamptz;

-- Ссылку на оплату ЮKassa отдаёт только при создании платежа, поэтому храним
-- её: иначе при повторном заходе клиенту некуда было бы идти.
alter table public.leads
  add column if not exists payment_url text;

-- Допустимые статусы оплаты. Значения совпадают со статусами ЮKassa,
-- поэтому вебхук можно сохранять без перевода.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_payment_status_check') then
    alter table public.leads
      add constraint leads_payment_status_check
      check (payment_status is null or payment_status in ('pending', 'waiting_for_capture', 'succeeded', 'canceled'));
  end if;
end $$;

-- Сумма не может быть отрицательной.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_payment_amount_check') then
    alter table public.leads
      add constraint leads_payment_amount_check
      check (payment_amount is null or payment_amount >= 0);
  end if;
end $$;

-- Внешний ключ на каталог: удаление услуги не должно ломать заявку.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_service_id_fkey') then
    alter table public.leads
      add constraint leads_service_id_fkey
      foreign key (service_id) references public.services (id) on delete set null;
  end if;
end $$;

-- Поиск заявки по платежу нужен вебхуку.
create index if not exists leads_payment_id_idx
  on public.leads (payment_id) where payment_id is not null;

-- --- 3. Связываем старые заявки с каталогом -------------------------------
--
-- В заявке услуга записана текстом вида «🧹 Чистка от пыли — 1500 руб»:
-- перед названием стоит значок, после — цена и другой текст. Поэтому ищем
-- название каталога внутри строки заявки.
--
-- Совпадение должно быть однозначным: если подходит несколько услуг каталога,
-- связь не ставим — лучше без связи, чем угадать неправильно.
update public.leads l
   set service_id = matched.service_id
  from (
    select l2.id as lead_id, min(s.id::text)::uuid as service_id
      from public.leads l2
      join public.services s
        on lower(l2.service) like '%' || lower(s.title) || '%'
     where l2.service_id is null
       and l2.service is not null
       and btrim(l2.service) <> 'Не выбрана'
     group by l2.id
    having count(distinct s.id) = 1
  ) as matched
 where l.id = matched.lead_id;

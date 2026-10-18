-- Цена услуги становится одной: числовой.
--
-- Раньше цена хранилась дважды: текстом (`price`, например «1 000 руб.») и
-- числом (`price_value`). Значения расходились, и было непонятно, какое
-- правильное. Остаётся только число — из него собирается и текст на сайте,
-- и сумма платежа.
--
-- Заодно убираем признак «цена от»: все услуги теперь с фиксированной ценой,
-- поэтому оплатить можно любую.

-- --- 1. Убираем текстовую цену и признак «от» -----------------------------
alter table public.services drop column if exists price;
alter table public.services drop column if exists price_is_from;

-- Числовая цена становится обязательной и положительной.
update public.services set price_value = 0 where price_value is null;

alter table public.services
  alter column price_value set default 0;

alter table public.services
  alter column price_value set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'services_price_value_check') then
    alter table public.services
      add constraint services_price_value_check check (price_value >= 0);
  end if;
end $$;

-- --- 2. Убираем смайлики из названий услуг --------------------------------
--
-- Название услуги нужно и на сайте, и в фильтре админки, и в заявке. Значки
-- мешали сравнению и выглядели по-разному в разных местах, поэтому оставляем
-- только текст.
update public.services
   set title = btrim(regexp_replace(title, '[^[:alnum:][:space:][:punct:]]', '', 'g'))
 where title ~ '[^[:alnum:][:space:][:punct:]]';

-- Названия не должны остаться пустыми после чистки.
update public.services
   set title = 'Услуга'
 where btrim(title) = '';

-- --- 3. Убираем смайлики из уже сохранённых названий в заявках ------------
--
-- Заявка хранит название услуги текстом на момент создания. Значки из старых
-- записей тоже убираем, чтобы список выглядел одинаково.
update public.leads
   set service = btrim(regexp_replace(service, '[^[:alnum:][:space:][:punct:]]', '', 'g'))
 where service ~ '[^[:alnum:][:space:][:punct:]]';

-- --- 4. Убираем цену из названия услуги в старых заявках ------------------
--
-- Заявка сохраняла услугу текстом вместе с ценой («Замена термопасты —
-- 1 000 руб.»). Теперь цена живёт только в каталоге, поэтому из названия её
-- убираем: иначе в заявке и на сайте будут разные суммы.
update public.leads
   set service = btrim(split_part(service, ' — ', 1))
 where service like '% — %'
   and btrim(split_part(service, ' — ', 1)) <> '';

-- Заодно связываем записи с каталогом по точному названию.
update public.leads l
   set service_id = s.id
  from public.services s
 where l.service_id is null
   and l.service = s.title;

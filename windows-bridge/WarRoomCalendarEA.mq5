#property strict
#property version   "1.00"
#property description "Exports high-impact MT5 economic calendar events for the WarRoom bridge."

input int RefreshSeconds = 60;
input int BlackoutMinutes = 15;
input string ExportFileName = "warroom_calendar.json";

string JsonEscape(string value)
{
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", " ");
   StringReplace(value, "\n", " ");
   StringReplace(value, "\t", " ");
   return value;
}

string IsoUtc(datetime value)
{
   string formatted = TimeToString(value, TIME_DATE | TIME_SECONDS);
   StringReplace(formatted, ".", "-");
   StringReplace(formatted, " ", "T");
   return formatted + "Z";
}

bool WriteSnapshot()
{
   datetime server_now = TimeTradeServer();
   datetime utc_now = TimeGMT();
   if(server_now <= 0 || utc_now <= 0)
      return false;

   datetime from_time = server_now - BlackoutMinutes * 60;
   datetime to_time = server_now + BlackoutMinutes * 60;
   MqlCalendarValue values[];
   ResetLastError();
   int count = CalendarValueHistory(values, from_time, to_time);
   int error_code = GetLastError();
   bool available = count >= 0;
   string events = "";
   int written = 0;

   if(available)
   {
      long server_offset = (long)(server_now - utc_now);
      for(int i = 0; i < count; i++)
      {
         MqlCalendarEvent event;
         if(!CalendarEventById(values[i].event_id, event))
            continue;
         if(event.importance != CALENDAR_IMPORTANCE_HIGH)
            continue;

         MqlCalendarCountry country;
         if(!CalendarCountryById(event.country_id, country))
            continue;
         if(StringLen(country.currency) != 3)
            continue;

         if(written > 0)
            events += ",";
         events += StringFormat(
            "{\"event_id\":\"%I64d\",\"name\":\"%s\",\"currency\":\"%s\",\"importance\":\"HIGH\",\"scheduled_at\":\"%s\"}",
            (long)values[i].event_id,
            JsonEscape(event.name),
            JsonEscape(country.currency),
            IsoUtc((datetime)((long)values[i].time - server_offset))
         );
         written++;
      }
   }

   string error = available ? "" : StringFormat("CalendarValueHistory failed (%d)", error_code);
   string payload = StringFormat(
      "{\"generated_at\":\"%s\",\"available\":%s,\"error\":\"%s\",\"events\":[%s]}",
      IsoUtc(utc_now),
      available ? "true" : "false",
      JsonEscape(error),
      events
   );

   ResetLastError();
   int file = FileOpen(
      ExportFileName,
      FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON,
      0,
      CP_UTF8
   );
   if(file == INVALID_HANDLE)
   {
      PrintFormat("Unable to write calendar export (%d)", GetLastError());
      return false;
   }
   FileWriteString(file, payload);
   FileClose(file);
   return true;
}

int OnInit()
{
   if(RefreshSeconds < 10 || BlackoutMinutes < 1)
      return INIT_PARAMETERS_INCORRECT;
   EventSetTimer(RefreshSeconds);
   WriteSnapshot();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   if(!WriteSnapshot())
      Print("Calendar export failed; the bridge will fail closed if the file goes stale.");
}

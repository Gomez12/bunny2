kan je me helpen met brainstormen over een interne agent tool?

De technische basis-vereisten zijn

- Op bun gebaseerde server
- Vite gebaseerde frontend
- Op electron gebaseerde client zodat mensen het idee hebben dat het een losse app is, terwijl het de vite frontend is
- Portable multiplatform server (wel losse executables) met een config ernaast en een data-dir met daarin alle data
- SQlite voor database met mogelijkheid voor later postgresql
- LanceDB voor semantics
- Alle communicatie moet via een message bus lopen en een flow die te beinvloeden is, zodat als je dus bijv logging in de flow aanpast dat het vanaf dan direct voor alle loggings geldt. En de message bus (bunqueue?) is voornamelijk om geen event storms te veroorzaken.
- Je moet 1 basis llm opgeven, maar elk los onderdeel moet ook via een eigen llm kunnen werken.
- Telemetry / analytics / logging is allemaal extreem belangrijk, zeker op alle llm-paths moet er 100% message logging zijn om later te kunnen achterhalen wat en hoeveel tokens er naar een model zijn gegaan.

Functioneel is de bedoeling dat het systeem eigen entiteiten heeft die via CRUD bijgewerkt kunnen worden, maar die expliciet periodiek door AI enhanced worden en bijgehouden worden zodat de user zo min mogelijk CRUD hoeft te doen. Ook moeten entiteiten externe koppelingen kunnen hebben naar externe systemen.

Praktisch moeten er meerdere lagen entiteiten kunnen zijn, bijv personal als level1, personal project als level2 etc en allemaal hebben ze toegang tot hun eigen entiteiten en alle daarboven liggende

Het moet een multi-user systeem zijn, beginnend met username / password en dan moet dus overal de mogelijkheid zijn om te zeggen deze entiteit / laag is personal / group x/y/z / everyone en dan dus per laag te zeggen zijn of het top-down en/of bottom-up moet werken

Per laag moet je agents / skills / mcp servers kunnen toevoegen

Entiteiten : \
De volgende basis-entiteiten moeten er dus per laag zijn :

- Bedrijven
- Contactpersonen
- Kalender
- Todo
- Kanban Boards
- Workflows functionaliteit
- Whiteboard functionaliteit (via excalidraw)
- Dagboek
- Diagrammen
- Documenten
- File Storage
- Knowledge base
- External news
- Scheduled Tasks
- Personal messages for knowledge (email / alle chats voor de user)

En de intentie is dus dat dit allemaal losse entiteiten zijn die allemaal via CRUD los te bewerken zijn, dat ze externe entities kunnen accepteren qua synchs (bijv google calendar)\
En dat ze allemaal hun eigen souls en memory gedeeltes hebben.\
En dat er dan automatisch dus allemaal synchs en ai-acties lopen om alles in synch te houden (een todo actie met een due date kan dus in een kalender getoond worden)\
Praktisch moet het allemaal via event-sourcing lopen gebacked bij scheduled actions om de errors te herhalen. En om de fouten te achterhalen. En om het later simpelweg uit te kunnen breiden met nieuwe entiteiten.

En er moet dus per laag ook nog een dashboard functionaliteit zijn die de situatie van het dashboard toont.

En dan nu het belangrijkste, er moet een chat-interface boven komen die self-enhancing en self-learning is en per laag te benaderen. Dat moet echt een persoonlijke assistent worden die werkt met en voor de entities, over meerdere chat-berichten en inzichtelijk gemaakt via een kanban board.

Dus een gebruiker zegt : Wanneer heb ik de ontmoeting met 2ba, dan moet er eerst een router zijn die de intentie bepaalt dan die bepaalt welke entiteiten het om gaat (hier kalender en bedrijf of contactpersonen of users) en dan de info erbij zoekt en dan pas een antwoord geeft. Gebruiker kan met duimpje omhoog of omlaag aangeven of hij het goed vind, omlaag kan mogelijk tot de vraag leiden of hij het opnieuw moet proberen.\
Met dus een kanban board om het inzichtelijk te maken voor de gebruiker.\
En dit gedeelte moet dus self-learning / self-healing zijn. Periodiek moet er dus per laag een scheduled agent lopen die kijkt naar alle antwoorden met thumb up or down of die niet te verbeteren zijn met extra zelf te bouwen tools, of het verbeteren van zelfgebouwde tools, of zelf skills maken, of zelf agents maken.

In 1e instantie moet het self-learning/self-healing gedeelte user-verified zijn, de agent moet het probleem benoemen wat hij zag, wat hij eraan wil doen en wat de impact voor de user/het systeem is (zodat de onbelangrijke dingen snel weg te filteren zijn) uitgaande van de bestaande mogelijkheden van het systeem en dit moet dus op een lijst getoond worden (inclusief inzicht voor de gebruiker) en als de gebruiker het dus goedkeurt dan moet het systeem dus opnieuw herbekijken of de mogelijkheden niet verandert zijn (bijv iemand anders heeft iets goedgekeurd wat hier invloed op heeft) en een nieuw plan maken en dan dat plan gaan bouwen als tool / agent / skill met als doel om de user beter te kunnen beantwoorden.\
\
Bijv de user kan in de chat vragen "Voeg [www.ami.nl](http://www.ami.nl) toe als nieuw bedrijf + contactpersonen" dan kan de agent in 1e instantie de taak volbrengen op manier 1, maar bijv daarna zien dat bij een nieuwe bedrijf er een separate lookup naar [kvk.nl](http://kvk.nl) gaat voor bedrijfsgegevens en dan kan het dus beter zijn om een tool te maken die meerdere dingen in 1x doet.

Of anders gezegd : “Het systeem detecteert verbeterkansen, maakt een voorstel, test het in een sandbox, toont bewijs, en pas na goedkeuring wordt het actief.”\
\
En het systeem / elke laag moet 100% multi-language zijn (de basis-sets van languages wordt door system-settings bepaald en dan kan elke laag daar dus sub-selecties van maken) praktisch betekent dit dat je moet bijhouden in welke taal iets origineel geinput is, en dat scheduled translaten naar de andere languages en de gebruiker moet alleen de originele taal kunnen editten (of de edit-taal kunnen wijzigen)

Ik wil alle Id's als uuid hebben zodat toekomstig je meerdere servers kan koppelen en data uitwisselen.\
Praktisch moet je niets kunnen deleten, alleen soft-deleten waardoor het voor de user en agents verdwijnt, maar het daadwerkelijke verwijderen kan alleen door een admin gebeuren.\
\
Praktisch moet er qua access alles werken op groepen, 1 user kan in meerdere groepen zitten, groepen moeten gegroepeerd kunnen worden (systeem / project etc) en er moet bij afwezig zijn 1 systeem admin groep gecreeerd worden waar een standaard admin in geseed wordt (met als standaard wachtwoord change_me wat bij 1e install inlog moet worden)\
\
Elke entitieit moet geversioned zijn, van elke entiteit moet dus uitgebreide meta-data bijgehouden

Electron client = alleen wrapper, praktisch moet die geen magie bevatten. Het doel is de web-ui, de wrapper is een toevoeging voor de user, niet de main use-case.\
\
Mijn idee is om dit in fases te doen.

Fase 1 : System setup, dit moet dus het systeem op zichzelf zijn, dus dat het het kan opslaan en dat er een messagequeue is en een llm en een UI met simpele inzichtelijkheid en simpele chat-mogelijkheid zodat de basis te testen is.\
Fase 2 : Users / groepen toevoegen inclusief inlog mogelijkheid\
Fase 3 : Lagen toevoegen (zodat de gebruiker dus zelf lagen kan beheren)\
Fase 4 : 1 voor 1 de volgende entiteiten toevoegen als subfases, met als sub-sub-fases nog het plannen van scheduled tasks / ai-enrichment per entiteit : Bedrijven , contactpersonen, agenda, todos

Fase 5 : Algemene scheduled tasks toevoegen

Fase 6 : Super-chat prompt toevoegen (waar het dus om gaat)\
Fase 7 : Self-learning / self-healing suggesties voor super-chat prompt toevoegen waarbij de self-learning dus echt effectief moet bewijzen wat de voorgestelde aanpassing gaat brengen. De user moet dit goedkeuren.

Fase 8 : Self-learning / self-healing suggesties boven een bepaalde threshold mogen automatisch gebouwd worden, let op dat dus de threshold al in fase 7 moet zitten\
later : Rest van de entiteiten toevoegen

Enkele dingen waar je nog rekening mee moet houden, lancedb moet dus niet verborgen info naar boven kunnen halen.

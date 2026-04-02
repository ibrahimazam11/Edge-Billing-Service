CREATE TABLE "processed_events" (
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processed_events_event_id_event_type_pk" PRIMARY KEY("event_id","event_type")
);

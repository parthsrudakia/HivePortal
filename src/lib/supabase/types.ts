export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      agreement_addresses: {
        Row: {
          confirmed_at: string
          full_address: string
          property_id: string
        }
        Insert: {
          confirmed_at?: string
          full_address: string
          property_id: string
        }
        Update: {
          confirmed_at?: string
          full_address?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "agreement_addresses_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          after_data: Json | null
          before_data: Json | null
          changed_columns: string[] | null
          created_at: string
          id: string
          record_id: string | null
          table_name: string
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          after_data?: Json | null
          before_data?: Json | null
          changed_columns?: string[] | null
          created_at?: string
          id?: string
          record_id?: string | null
          table_name: string
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          after_data?: Json | null
          before_data?: Json | null
          changed_columns?: string[] | null
          created_at?: string
          id?: string
          record_id?: string | null
          table_name?: string
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      board_comments: {
        Row: {
          author: string | null
          author_label: string | null
          created_at: string
          id: string
          task_id: string
          text: string
        }
        Insert: {
          author?: string | null
          author_label?: string | null
          created_at?: string
          id?: string
          task_id: string
          text: string
        }
        Update: {
          author?: string | null
          author_label?: string | null
          created_at?: string
          id?: string
          task_id?: string
          text?: string
        }
        Relationships: [
          {
            foreignKeyName: "board_comments_task_id_fkey"
            columns: ["task_id"]
            isOneToOne: false
            referencedRelation: "board_tasks"
            referencedColumns: ["id"]
          },
        ]
      }
      board_prefs: {
        Row: {
          email_notifications: boolean
          user_id: string
        }
        Insert: {
          email_notifications?: boolean
          user_id: string
        }
        Update: {
          email_notifications?: boolean
          user_id?: string
        }
        Relationships: []
      }
      board_tasks: {
        Row: {
          assigned_label: string | null
          assigned_to: string | null
          created_at: string
          deadline: string | null
          description: string | null
          id: string
          last_completed_month: string | null
          missed_months: string[]
          needs_attention: boolean
          nudge_history: string[]
          recurring: boolean
          recurring_day: number | null
          seen_by_assignee: boolean
          seq: number
          status: string
          title: string
          updated_at: string
          urgent: boolean
        }
        Insert: {
          assigned_label?: string | null
          assigned_to?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          id?: string
          last_completed_month?: string | null
          missed_months?: string[]
          needs_attention?: boolean
          nudge_history?: string[]
          recurring?: boolean
          recurring_day?: number | null
          seen_by_assignee?: boolean
          seq?: never
          status?: string
          title: string
          updated_at?: string
          urgent?: boolean
        }
        Update: {
          assigned_label?: string | null
          assigned_to?: string | null
          created_at?: string
          deadline?: string | null
          description?: string | null
          id?: string
          last_completed_month?: string | null
          missed_months?: string[]
          needs_attention?: boolean
          nudge_history?: string[]
          recurring?: boolean
          recurring_day?: number | null
          seen_by_assignee?: boolean
          seq?: never
          status?: string
          title?: string
          updated_at?: string
          urgent?: boolean
        }
        Relationships: []
      }
      cleaner_schedule_change_queue: {
        Row: {
          cleaner_id: string
          created_at: string
          id: string
          reason: string | null
          sent_at: string | null
          week_start: string
        }
        Insert: {
          cleaner_id: string
          created_at?: string
          id?: string
          reason?: string | null
          sent_at?: string | null
          week_start: string
        }
        Update: {
          cleaner_id?: string
          created_at?: string
          id?: string
          reason?: string | null
          sent_at?: string | null
          week_start?: string
        }
        Relationships: [
          {
            foreignKeyName: "cleaner_schedule_change_queue_cleaner_id_fkey"
            columns: ["cleaner_id"]
            isOneToOne: false
            referencedRelation: "cleaners"
            referencedColumns: ["id"]
          },
        ]
      }
      cleaners: {
        Row: {
          created_at: string
          email: string
          enabled: boolean
          id: string
          name: string
          phone: string | null
          schedule_token: string
        }
        Insert: {
          created_at?: string
          email: string
          enabled?: boolean
          id?: string
          name: string
          phone?: string | null
          schedule_token?: string
        }
        Update: {
          created_at?: string
          email?: string
          enabled?: boolean
          id?: string
          name?: string
          phone?: string | null
          schedule_token?: string
        }
        Relationships: []
      }
      cleaning_records: {
        Row: {
          assigned_to: string | null
          cleaning_date: string
          created_at: string
          id: string
          kind: string
          notes: string | null
          property_id: string
          room_id: string | null
        }
        Insert: {
          assigned_to?: string | null
          cleaning_date: string
          created_at?: string
          id?: string
          kind?: string
          notes?: string | null
          property_id: string
          room_id?: string | null
        }
        Update: {
          assigned_to?: string | null
          cleaning_date?: string
          created_at?: string
          id?: string
          kind?: string
          notes?: string | null
          property_id?: string
          room_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cleaning_records_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cleaning_records_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cleaning_records_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["room_id"]
          },
        ]
      }
      credential_access_log: {
        Row: {
          accessed_at: string
          accessed_by: string | null
          action: string | null
          credential_id: string
          id: string
        }
        Insert: {
          accessed_at?: string
          accessed_by?: string | null
          action?: string | null
          credential_id: string
          id?: string
        }
        Update: {
          accessed_at?: string
          accessed_by?: string | null
          action?: string | null
          credential_id?: string
          id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credential_access_log_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "credentials"
            referencedColumns: ["id"]
          },
        ]
      }
      credentials: {
        Row: {
          account_number: string | null
          category: Database["public"]["Enums"]["credential_category"]
          created_at: string
          id: string
          login_url: string | null
          notes: string | null
          owner_label: string | null
          password: string | null
          property_id: string | null
          service_name: string
          updated_at: string
          username: string | null
        }
        Insert: {
          account_number?: string | null
          category: Database["public"]["Enums"]["credential_category"]
          created_at?: string
          id?: string
          login_url?: string | null
          notes?: string | null
          owner_label?: string | null
          password?: string | null
          property_id?: string | null
          service_name: string
          updated_at?: string
          username?: string | null
        }
        Update: {
          account_number?: string | null
          category?: Database["public"]["Enums"]["credential_category"]
          created_at?: string
          id?: string
          login_url?: string | null
          notes?: string | null
          owner_label?: string | null
          password?: string | null
          property_id?: string | null
          service_name?: string
          updated_at?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "credentials_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      credit_allocations: {
        Row: {
          amount: number
          created_at: string
          id: string
          kind: string
          note: string | null
          tenancy_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          kind: string
          note?: string | null
          tenancy_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          tenancy_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credit_allocations_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credit_allocations_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "credit_allocations_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
        ]
      }
      email_log: {
        Row: {
          channel: string
          context: string | null
          created_at: string
          error: string | null
          id: string
          recipient: string
          resend_id: string | null
          status: string
          subject: string | null
          type: string
        }
        Insert: {
          channel?: string
          context?: string | null
          created_at?: string
          error?: string | null
          id?: string
          recipient: string
          resend_id?: string | null
          status: string
          subject?: string | null
          type: string
        }
        Update: {
          channel?: string
          context?: string | null
          created_at?: string
          error?: string | null
          id?: string
          recipient?: string
          resend_id?: string | null
          status?: string
          subject?: string | null
          type?: string
        }
        Relationships: []
      }
      email_queue: {
        Row: {
          attempts: number
          bcc_addrs: string[] | null
          context: string | null
          created_at: string
          from_addr: string
          html_body: string | null
          id: string
          last_error: string | null
          reply_to: string | null
          sent_at: string | null
          status: string
          subject: string
          text_body: string | null
          to_addrs: string[]
          type: string
        }
        Insert: {
          attempts?: number
          bcc_addrs?: string[] | null
          context?: string | null
          created_at?: string
          from_addr: string
          html_body?: string | null
          id?: string
          last_error?: string | null
          reply_to?: string | null
          sent_at?: string | null
          status?: string
          subject: string
          text_body?: string | null
          to_addrs: string[]
          type: string
        }
        Update: {
          attempts?: number
          bcc_addrs?: string[] | null
          context?: string | null
          created_at?: string
          from_addr?: string
          html_body?: string | null
          id?: string
          last_error?: string | null
          reply_to?: string | null
          sent_at?: string | null
          status?: string
          subject?: string
          text_body?: string | null
          to_addrs?: string[]
          type?: string
        }
        Relationships: []
      }
      leaseholders: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      marketing_channels: {
        Row: {
          active: boolean
          created_at: string
          id: string
          name: string
          notes: string | null
          platform: Database["public"]["Enums"]["marketing_platform"]
          posting_cadence_days: number | null
          updated_at: string
          url: string | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          platform?: Database["public"]["Enums"]["marketing_platform"]
          posting_cadence_days?: number | null
          updated_at?: string
          url?: string | null
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          name?: string
          notes?: string | null
          platform?: Database["public"]["Enums"]["marketing_platform"]
          posting_cadence_days?: number | null
          updated_at?: string
          url?: string | null
        }
        Relationships: []
      }
      notification_recipients: {
        Row: {
          created_at: string
          email: string
          enabled: boolean
          id: string
          label: string | null
        }
        Insert: {
          created_at?: string
          email: string
          enabled?: boolean
          id?: string
          label?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          enabled?: boolean
          id?: string
          label?: string | null
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount: number
          created_at: string
          external_ref: string | null
          id: string
          method: string | null
          notes: string | null
          paid_on: string
          payment_type: Database["public"]["Enums"]["payment_type"]
          reconciliation_run_id: string | null
          tenancy_id: string
        }
        Insert: {
          amount: number
          created_at?: string
          external_ref?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          paid_on: string
          payment_type?: Database["public"]["Enums"]["payment_type"]
          reconciliation_run_id?: string | null
          tenancy_id: string
        }
        Update: {
          amount?: number
          created_at?: string
          external_ref?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          paid_on?: string
          payment_type?: Database["public"]["Enums"]["payment_type"]
          reconciliation_run_id?: string | null
          tenancy_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_reconciliation_run_id_fkey"
            columns: ["reconciliation_run_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "payments_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
        ]
      }
      posting_log: {
        Row: {
          ad_url: string | null
          channel_id: string
          id: string
          notes: string | null
          posted_at: string
        }
        Insert: {
          ad_url?: string | null
          channel_id: string
          id?: string
          notes?: string | null
          posted_at?: string
        }
        Update: {
          ad_url?: string | null
          channel_id?: string
          id?: string
          notes?: string | null
          posted_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "posting_log_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "marketing_channels"
            referencedColumns: ["id"]
          },
        ]
      }
      properties: {
        Row: {
          amenities_notes: string | null
          bathrooms: number | null
          bedrooms: number | null
          building_amenities: string[]
          building_name: string | null
          created_at: string
          cross_street: string | null
          id: string
          is_new_york: boolean
          leaseholder_id: string | null
          neighborhood: string | null
          notes: string | null
          street_address: string
          unit_amenities: string[]
          unit_number: string
          updated_at: string
        }
        Insert: {
          amenities_notes?: string | null
          bathrooms?: number | null
          bedrooms?: number | null
          building_amenities?: string[]
          building_name?: string | null
          created_at?: string
          cross_street?: string | null
          id?: string
          is_new_york?: boolean
          leaseholder_id?: string | null
          neighborhood?: string | null
          notes?: string | null
          street_address: string
          unit_amenities?: string[]
          unit_number: string
          updated_at?: string
        }
        Update: {
          amenities_notes?: string | null
          bathrooms?: number | null
          bedrooms?: number | null
          building_amenities?: string[]
          building_name?: string | null
          created_at?: string
          cross_street?: string | null
          id?: string
          is_new_york?: boolean
          leaseholder_id?: string | null
          neighborhood?: string | null
          notes?: string | null
          street_address?: string
          unit_amenities?: string[]
          unit_number?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_leaseholder_id_fkey"
            columns: ["leaseholder_id"]
            isOneToOne: false
            referencedRelation: "leaseholders"
            referencedColumns: ["id"]
          },
        ]
      }
      property_cleaners: {
        Row: {
          cleaner_id: string
          created_at: string
          property_id: string
        }
        Insert: {
          cleaner_id: string
          created_at?: string
          property_id: string
        }
        Update: {
          cleaner_id?: string
          created_at?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_cleaners_cleaner_id_fkey"
            columns: ["cleaner_id"]
            isOneToOne: false
            referencedRelation: "cleaners"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "property_cleaners_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_deposits: {
        Row: {
          amount: number
          created_at: string
          deposit_date: string | null
          external_ref: string
          id: string
          payer_key: string
          payment_id: string | null
          raw_description: string
          run_id: string
          tenancy_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          deposit_date?: string | null
          external_ref: string
          id?: string
          payer_key: string
          payment_id?: string | null
          raw_description: string
          run_id: string
          tenancy_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          deposit_date?: string | null
          external_ref?: string
          id?: string
          payer_key?: string
          payment_id?: string | null
          raw_description?: string
          run_id?: string
          tenancy_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_deposits_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_deposits_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_deposits_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_deposits_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "reconciliation_deposits_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
        ]
      }
      reconciliation_matches: {
        Row: {
          actual_amount: number | null
          created_at: string
          difference: number | null
          expected_rent: number | null
          id: string
          pays_as: string | null
          property_label: string | null
          room_label: string | null
          run_id: string
          status: string | null
          tenancy_id: string | null
          tenant_id: string | null
          tenant_name: string | null
        }
        Insert: {
          actual_amount?: number | null
          created_at?: string
          difference?: number | null
          expected_rent?: number | null
          id?: string
          pays_as?: string | null
          property_label?: string | null
          room_label?: string | null
          run_id: string
          status?: string | null
          tenancy_id?: string | null
          tenant_id?: string | null
          tenant_name?: string | null
        }
        Update: {
          actual_amount?: number | null
          created_at?: string
          difference?: number | null
          expected_rent?: number | null
          id?: string
          pays_as?: string | null
          property_label?: string | null
          room_label?: string | null
          run_id?: string
          status?: string | null
          tenancy_id?: string | null
          tenant_id?: string | null
          tenant_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reconciliation_matches_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "reconciliation_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_matches_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reconciliation_matches_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "reconciliation_matches_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "reconciliation_matches_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      reconciliation_runs: {
        Row: {
          bank_statement_path: string | null
          created_at: string
          id: string
          match_count: number | null
          mismatch_count: number | null
          missing_count: number | null
          month: string
          notes: string | null
          other_payments_path: string | null
          posted_at: string | null
          total_actual: number | null
          total_expected: number | null
          unmatched_deposits: Json | null
        }
        Insert: {
          bank_statement_path?: string | null
          created_at?: string
          id?: string
          match_count?: number | null
          mismatch_count?: number | null
          missing_count?: number | null
          month: string
          notes?: string | null
          other_payments_path?: string | null
          posted_at?: string | null
          total_actual?: number | null
          total_expected?: number | null
          unmatched_deposits?: Json | null
        }
        Update: {
          bank_statement_path?: string | null
          created_at?: string
          id?: string
          match_count?: number | null
          mismatch_count?: number | null
          missing_count?: number | null
          month?: string
          notes?: string | null
          other_payments_path?: string | null
          posted_at?: string | null
          total_actual?: number | null
          total_expected?: number | null
          unmatched_deposits?: Json | null
        }
        Relationships: []
      }
      rent_reminder_batches: {
        Row: {
          channel: string
          created_at: string
          id: string
          kind: string
          period_month: string
          recipient_count: number
          triggered_by: string | null
        }
        Insert: {
          channel?: string
          created_at?: string
          id?: string
          kind: string
          period_month: string
          recipient_count?: number
          triggered_by?: string | null
        }
        Update: {
          channel?: string
          created_at?: string
          id?: string
          kind?: string
          period_month?: string
          recipient_count?: number
          triggered_by?: string | null
        }
        Relationships: []
      }
      rent_reminder_emails: {
        Row: {
          created_at: string
          email_to: string
          error_text: string | null
          id: string
          period_month: string
          resend_id: string | null
          sent_at: string | null
          sms_sent_at: string | null
          tenancy_id: string
          tenant_id: string
        }
        Insert: {
          created_at?: string
          email_to: string
          error_text?: string | null
          id?: string
          period_month: string
          resend_id?: string | null
          sent_at?: string | null
          sms_sent_at?: string | null
          tenancy_id: string
          tenant_id: string
        }
        Update: {
          created_at?: string
          email_to?: string
          error_text?: string | null
          id?: string
          period_month?: string
          resend_id?: string | null
          sent_at?: string | null
          sms_sent_at?: string | null
          tenancy_id?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "rent_reminder_emails_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rent_reminder_emails_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "rent_reminder_emails_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "rent_reminder_emails_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      room_ads: {
        Row: {
          created_at: string
          id: string
          posted_by: string | null
          room_id: string
          url: string
        }
        Insert: {
          created_at?: string
          id?: string
          posted_by?: string | null
          room_id: string
          url: string
        }
        Update: {
          created_at?: string
          id?: string
          posted_by?: string | null
          room_id?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_ads_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_ads_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["room_id"]
          },
        ]
      }
      room_change_events: {
        Row: {
          changed_at: string
          field: string
          followup_error: string | null
          followup_sent_at: string | null
          from_value: string | null
          id: string
          immediate_error: string | null
          immediate_sent_at: string | null
          room_id: string
          to_value: string | null
        }
        Insert: {
          changed_at?: string
          field: string
          followup_error?: string | null
          followup_sent_at?: string | null
          from_value?: string | null
          id?: string
          immediate_error?: string | null
          immediate_sent_at?: string | null
          room_id: string
          to_value?: string | null
        }
        Update: {
          changed_at?: string
          field?: string
          followup_error?: string | null
          followup_sent_at?: string | null
          from_value?: string | null
          id?: string
          immediate_error?: string | null
          immediate_sent_at?: string | null
          room_id?: string
          to_value?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "room_change_events_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "room_change_events_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["room_id"]
          },
        ]
      }
      rooms: {
        Row: {
          ad_boosted: boolean
          ad_posted_by: string | null
          ad_url: string | null
          available_from: string | null
          base_rent: number | null
          bundle_fee: number | null
          created_at: string
          has_ac: boolean
          has_private_bathroom: boolean
          id: string
          listing_action: Database["public"]["Enums"]["listing_action"]
          marketing_description: string | null
          notes: string | null
          pending_tenant: boolean
          photos_url: string | null
          property_id: string
          room_number: string | null
          status: Database["public"]["Enums"]["room_status"]
          total_rent: number | null
          updated_at: string
        }
        Insert: {
          ad_boosted?: boolean
          ad_posted_by?: string | null
          ad_url?: string | null
          available_from?: string | null
          base_rent?: number | null
          bundle_fee?: number | null
          created_at?: string
          has_ac?: boolean
          has_private_bathroom?: boolean
          id?: string
          listing_action?: Database["public"]["Enums"]["listing_action"]
          marketing_description?: string | null
          notes?: string | null
          pending_tenant?: boolean
          photos_url?: string | null
          property_id: string
          room_number?: string | null
          status?: Database["public"]["Enums"]["room_status"]
          total_rent?: number | null
          updated_at?: string
        }
        Update: {
          ad_boosted?: boolean
          ad_posted_by?: string | null
          ad_url?: string | null
          available_from?: string | null
          base_rent?: number | null
          bundle_fee?: number | null
          created_at?: string
          has_ac?: boolean
          has_private_bathroom?: boolean
          id?: string
          listing_action?: Database["public"]["Enums"]["listing_action"]
          marketing_description?: string | null
          notes?: string | null
          pending_tenant?: boolean
          photos_url?: string | null
          property_id?: string
          room_number?: string | null
          status?: Database["public"]["Enums"]["room_status"]
          total_rent?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      sms_log: {
        Row: {
          body: string | null
          channel: string
          context: string | null
          created_at: string
          error: string | null
          id: string
          recipient: string
          status: string
          type: string
        }
        Insert: {
          body?: string | null
          channel?: string
          context?: string | null
          created_at?: string
          error?: string | null
          id?: string
          recipient: string
          status: string
          type: string
        }
        Update: {
          body?: string | null
          channel?: string
          context?: string | null
          created_at?: string
          error?: string | null
          id?: string
          recipient?: string
          status?: string
          type?: string
        }
        Relationships: []
      }
      telegram_activity_log: {
        Row: {
          chat_id: number
          created_at: string
          detail: Json | null
          error: string | null
          id: number
          kind: string
          latency_ms: number | null
          ok: boolean | null
          telegram_user_id: number | null
          text: string | null
          tool_name: string | null
          turn_id: string | null
          username: string | null
        }
        Insert: {
          chat_id: number
          created_at?: string
          detail?: Json | null
          error?: string | null
          id?: number
          kind: string
          latency_ms?: number | null
          ok?: boolean | null
          telegram_user_id?: number | null
          text?: string | null
          tool_name?: string | null
          turn_id?: string | null
          username?: string | null
        }
        Update: {
          chat_id?: number
          created_at?: string
          detail?: Json | null
          error?: string | null
          id?: number
          kind?: string
          latency_ms?: number | null
          ok?: boolean | null
          telegram_user_id?: number | null
          text?: string | null
          tool_name?: string | null
          turn_id?: string | null
          username?: string | null
        }
        Relationships: []
      }
      telegram_chat_messages: {
        Row: {
          chat_id: number
          content: Json
          created_at: string
          id: number
          role: string
        }
        Insert: {
          chat_id: number
          content: Json
          created_at?: string
          id?: number
          role: string
        }
        Update: {
          chat_id?: number
          content?: Json
          created_at?: string
          id?: number
          role?: string
        }
        Relationships: []
      }
      telegram_updates: {
        Row: {
          chat_id: number | null
          received_at: string
          update_id: number
        }
        Insert: {
          chat_id?: number | null
          received_at?: string
          update_id: number
        }
        Update: {
          chat_id?: number | null
          received_at?: string
          update_id?: number
        }
        Relationships: []
      }
      tenancies: {
        Row: {
          created_at: string
          first_month_rent: number | null
          id: string
          lease_end_date: string | null
          lease_end_reminded_30_at: string | null
          lease_end_reminded_at: string | null
          lease_pdf_path: string | null
          monthly_rent: number
          move_out_date: string | null
          notes: string | null
          room_id: string
          security_deposit: number | null
          start_date: string
          status: Database["public"]["Enums"]["tenancy_status"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          first_month_rent?: number | null
          id?: string
          lease_end_date?: string | null
          lease_end_reminded_30_at?: string | null
          lease_end_reminded_at?: string | null
          lease_pdf_path?: string | null
          monthly_rent: number
          move_out_date?: string | null
          notes?: string | null
          room_id: string
          security_deposit?: number | null
          start_date: string
          status?: Database["public"]["Enums"]["tenancy_status"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          first_month_rent?: number | null
          id?: string
          lease_end_date?: string | null
          lease_end_reminded_30_at?: string | null
          lease_end_reminded_at?: string | null
          lease_pdf_path?: string | null
          monthly_rent?: number
          move_out_date?: string | null
          notes?: string | null
          room_id?: string
          security_deposit?: number | null
          start_date?: string
          status?: Database["public"]["Enums"]["tenancy_status"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenancies_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenancies_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["room_id"]
          },
          {
            foreignKeyName: "tenancies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenancy_charges: {
        Row: {
          amount: number
          bill_id: string | null
          charged_on: string
          created_at: string
          id: string
          kind: string
          note: string | null
          tenancy_id: string
        }
        Insert: {
          amount: number
          bill_id?: string | null
          charged_on?: string
          created_at?: string
          id?: string
          kind: string
          note?: string | null
          tenancy_id: string
        }
        Update: {
          amount?: number
          bill_id?: string | null
          charged_on?: string
          created_at?: string
          id?: string
          kind?: string
          note?: string | null
          tenancy_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenancy_charges_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "utility_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenancy_charges_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenancy_charges_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "tenancy_charges_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
        ]
      }
      tenancy_rent_history: {
        Row: {
          created_at: string
          effective_month: string
          id: string
          monthly_rent: number
          tenancy_id: string
        }
        Insert: {
          created_at?: string
          effective_month: string
          id?: string
          monthly_rent: number
          tenancy_id: string
        }
        Update: {
          created_at?: string
          effective_month?: string
          id?: string
          monthly_rent?: number
          tenancy_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenancy_rent_history_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenancy_rent_history_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "tenancy_rent_history_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
        ]
      }
      tenants: {
        Row: {
          age: number | null
          created_at: string
          email: string | null
          full_name: string
          gender: string | null
          id: string
          instagram_url: string | null
          linkedin_url: string | null
          notes: string | null
          pays_as: string | null
          phone: string | null
          profession: string | null
          updated_at: string
        }
        Insert: {
          age?: number | null
          created_at?: string
          email?: string | null
          full_name: string
          gender?: string | null
          id?: string
          instagram_url?: string | null
          linkedin_url?: string | null
          notes?: string | null
          pays_as?: string | null
          phone?: string | null
          profession?: string | null
          updated_at?: string
        }
        Update: {
          age?: number | null
          created_at?: string
          email?: string | null
          full_name?: string
          gender?: string | null
          id?: string
          instagram_url?: string | null
          linkedin_url?: string | null
          notes?: string | null
          pays_as?: string | null
          phone?: string | null
          profession?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      utility_bill_charges: {
        Row: {
          amount: number
          bill_id: string
          description: string | null
          id: string
          kind: string
        }
        Insert: {
          amount: number
          bill_id: string
          description?: string | null
          id?: string
          kind?: string
        }
        Update: {
          amount?: number
          bill_id?: string
          description?: string | null
          id?: string
          kind?: string
        }
        Relationships: [
          {
            foreignKeyName: "utility_bill_charges_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "utility_bills"
            referencedColumns: ["id"]
          },
        ]
      }
      utility_bills: {
        Row: {
          account_number: string | null
          created_at: string
          file_sha256: string | null
          id: string
          notes: string | null
          overage_charged_at: string | null
          overage_dismissed: boolean
          period_end: string | null
          period_start: string | null
          property_id: string | null
          provider: string | null
          service_address: string | null
          statement_date: string | null
          statement_path: string
          total_amount: number
          utility_type: string
        }
        Insert: {
          account_number?: string | null
          created_at?: string
          file_sha256?: string | null
          id?: string
          notes?: string | null
          overage_charged_at?: string | null
          overage_dismissed?: boolean
          period_end?: string | null
          period_start?: string | null
          property_id?: string | null
          provider?: string | null
          service_address?: string | null
          statement_date?: string | null
          statement_path: string
          total_amount?: number
          utility_type?: string
        }
        Update: {
          account_number?: string | null
          created_at?: string
          file_sha256?: string | null
          id?: string
          notes?: string | null
          overage_charged_at?: string | null
          overage_dismissed?: boolean
          period_end?: string | null
          period_start?: string | null
          property_id?: string | null
          provider?: string | null
          service_address?: string | null
          statement_date?: string | null
          statement_path?: string
          total_amount?: number
          utility_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "utility_bills_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      utility_overage_alerts: {
        Row: {
          acknowledged_at: string | null
          amount: number
          bill_id: string | null
          created_at: string
          id: string
          period_label: string
          tenancy_id: string | null
          tenant_name: string
          unit_label: string
        }
        Insert: {
          acknowledged_at?: string | null
          amount: number
          bill_id?: string | null
          created_at?: string
          id?: string
          period_label: string
          tenancy_id?: string | null
          tenant_name: string
          unit_label: string
        }
        Update: {
          acknowledged_at?: string | null
          amount?: number
          bill_id?: string | null
          created_at?: string
          id?: string
          period_label?: string
          tenancy_id?: string | null
          tenant_name?: string
          unit_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "utility_overage_alerts_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "utility_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_overage_alerts_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "tenancies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "utility_overage_alerts_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_current_month_status"
            referencedColumns: ["tenancy_id"]
          },
          {
            foreignKeyName: "utility_overage_alerts_tenancy_id_fkey"
            columns: ["tenancy_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["tenancy_id"]
          },
        ]
      }
      utility_unit_hints: {
        Row: {
          created_at: string
          key: string
          property_id: string
        }
        Insert: {
          created_at?: string
          key: string
          property_id: string
        }
        Update: {
          created_at?: string
          key?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "utility_unit_hints_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      v_current_month_status: {
        Row: {
          balance_due: number | null
          monthly_rent: number | null
          paid_this_month: number | null
          property_name: string | null
          room_id: string | null
          room_number: string | null
          tenancy_id: string | null
          tenant_email: string | null
          tenant_id: string | null
          tenant_name: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenancies_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenancies_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "v_room_occupancy"
            referencedColumns: ["room_id"]
          },
          {
            foreignKeyName: "tenancies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      v_room_occupancy: {
        Row: {
          available_from: string | null
          building_name: string | null
          has_private_bathroom: boolean | null
          move_out_date: string | null
          neighborhood: string | null
          property_id: string | null
          property_name: string | null
          room_id: string | null
          room_number: string | null
          room_status: Database["public"]["Enums"]["room_status"] | null
          start_date: string | null
          street_address: string | null
          tenancy_id: string | null
          tenancy_rent: number | null
          tenancy_status: Database["public"]["Enums"]["tenancy_status"] | null
          tenant_email: string | null
          tenant_id: string | null
          tenant_name: string | null
          tenant_phone: string | null
          total_rent: number | null
          unit_number: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rooms_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenancies_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      property_display_name: {
        Args: {
          building_name: string
          street_address: string
          unit_number: string
        }
        Returns: string
      }
    }
    Enums: {
      credential_category:
        | "payment_portal"
        | "maintenance_portal"
        | "utility"
        | "internet"
        | "building_login"
        | "other"
      listing_action:
        | "no_action"
        | "update_price_or_date"
        | "delete_listing"
        | "boost_post"
        | "priority"
      marketing_platform:
        | "facebook"
        | "craigslist"
        | "instagram"
        | "zillow"
        | "apartments_com"
        | "other"
      payment_type:
        | "rent"
        | "security_deposit"
        | "late_fee"
        | "utility"
        | "other"
        | "refund"
        | "broker_fee"
      room_status: "occupied" | "available" | "reserved" | "maintenance"
      tenancy_status: "active" | "ended" | "upcoming"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      credential_category: [
        "payment_portal",
        "maintenance_portal",
        "utility",
        "internet",
        "building_login",
        "other",
      ],
      listing_action: [
        "no_action",
        "update_price_or_date",
        "delete_listing",
        "boost_post",
        "priority",
      ],
      marketing_platform: [
        "facebook",
        "craigslist",
        "instagram",
        "zillow",
        "apartments_com",
        "other",
      ],
      payment_type: [
        "rent",
        "security_deposit",
        "late_fee",
        "utility",
        "other",
        "refund",
        "broker_fee",
      ],
      room_status: ["occupied", "available", "reserved", "maintenance"],
      tenancy_status: ["active", "ended", "upcoming"],
    },
  },
} as const

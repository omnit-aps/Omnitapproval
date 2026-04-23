/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([], () => {
  'use strict';

  return {
    RECORDS: {
      SETTINGS:  'customrecord_oa_settings',
      HIERARCHY: 'customrecord_oa_hierarchy',
      THRESHOLD: 'customrecord_oa_threshold',
      LOG:       'customrecord_oa_log'
    },

    FIELDS: {
      SETTINGS: {
        SUBSIDIARY:        'custrecord_oa_subsidiary',
        ENABLE_PO:         'custrecord_oa_enable_po',
        ENABLE_VB:         'custrecord_oa_enable_vb',
        APPROVER_COUNT:    'custrecord_oa_approver_count',
        USE_AMOUNT:        'custrecord_oa_use_amount',
        DEFAULT_APPROVER1: 'custrecord_oa_default_approver1',
        DEFAULT_APPROVER2: 'custrecord_oa_default_approver2',
        APPROVE_STRING:    'custrecord_oa_approve_string',
        REJECT_STRING:     'custrecord_oa_reject_string',
        EMAIL_ENABLED:     'custrecord_oa_email_enabled',
        TOKEN_EXPIRY_DAYS: 'custrecord_oa_token_expiry_days',
        EMAIL_SENDER:      'custrecord_oa_email_sender',
        EMAIL_SUBJECT:          'custrecord_oa_email_subject',
        EMAIL_INTRO:            'custrecord_oa_email_intro',
        APPROVE_WITHOUT_LOGIN:  'custrecord_oa_approve_without_login'
      },
      HIERARCHY: {
        SETTINGS:     'custrecord_oah_settings',
        NAME:         'custrecord_oah_name',
        RECORD_TYPE:  'custrecord_oah_record_type',
        CURRENCY:     'custrecord_oah_currency',
        STATUS:       'custrecord_oah_status',
        START_DATE:   'custrecord_oah_start_date',
        END_DATE:     'custrecord_oah_end_date',
        HIGHEST_ONLY: 'custrecord_oah_highest_only'
      },
      THRESHOLD: {
        HIERARCHY:  'custrecord_oat_hierarchy',
        LABEL:      'custrecord_oat_label',
        MIN_AMOUNT: 'custrecord_oat_min_amount',
        MAX_AMOUNT: 'custrecord_oat_max_amount',
        APPROVER:   'custrecord_oat_approver',
        APPROVER2:  'custrecord_oat_approver2',
        SORT_ORDER: 'custrecord_oat_sort_order'
      },
      LOG: {
        TRANSACTION: 'custrecord_oal_transaction',
        ACTION:      'custrecord_oal_action',
        ACTOR:       'custrecord_oal_actor',
        TARGET:      'custrecord_oal_target',
        TIMESTAMP:   'custrecord_oal_timestamp',
        COMMENT:     'custrecord_oal_comment',
        STEP:        'custrecord_oal_step',
        SOURCE:      'custrecord_oal_source'
      },
      EMPLOYEE: {
        IS_APPROVER:  'custentity_oa_is_approver',
        IS_MANAGER:   'custentity_oa_is_manager',
        CAN_DELEGATE: 'custentity_oa_can_delegate',
        USE_EMAIL:    'custentity_oa_use_email',
        DELEGATE_TO:  'custentity_oa_delegate_to'
      },
      TRANSACTION: {
        CURRENT_STEP:   'custbody_oa_current_step',
        APPROVER1:      'custbody_oa_approver1',
        APPROVER2:      'custbody_oa_approver2',
        SUBMITTED_BY:   'custbody_oa_submitted_by',
        APPROVAL_TOKEN: 'custbody_oa_approval_token',
        TOKEN_CREATED:  'custbody_oa_token_created',
        HIERARCHY_USED: 'custbody_oa_hierarchy_used'
      }
    },

    RECORD_TYPES: {
      PURCHASE_ORDER: 'purchaseorder',
      VENDOR_BILL:    'vendorbill'
    },

    APPROVAL_STATUS: {
      PENDING:  '1',
      APPROVED: '2',
      REJECTED: '3'
    },

    LOG_ACTIONS: {
      SUBMITTED:  '1',
      APPROVED:   '2',
      REJECTED:   '3',
      DELEGATED:  '4',
      REASSIGNED: '5',
      RESET:      '6'
    },

    LOG_SOURCES: {
      NETSUITE: '1',
      EMAIL:    '2'
    },

    HIERARCHY_STATUS: {
      DRAFT:   '1',
      ACTIVE:  '2',
      EXPIRED: '3'
    },

    HIERARCHY_RECORD_TYPES: {
      PO:   '1',
      VB:   '2',
      BOTH: '3'
    }
  };
});

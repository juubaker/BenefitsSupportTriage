// Realistic Oracle HCM Benefits support posts.
// Five answered, five open. Used as the initial demo queue.

export const SEED_POSTS = [
  {
    id: 'CC-7821',
    title: 'Birth life event not opening enrollment window for newborn',
    body:
      "Customer reports that when an employee adds a newborn through self-service, the Birth life event detects but the enrollment window does not open. Detection date appears correct. Program is active. The 'You and Family' option does not surface for re-election. Anyone seen this where the LE detects but no enrollment opportunity is created?",
    status: 'answered',
    seedCategory: 'life-events',
    source: 'Customer Connect',
    posted: '2026-04-22',
    author: 'jane.r@acmehealth.example',
    answer:
      "Most often this is the Life Event Reason missing from the Program's Life Events tab, or an Enrollment Period rule with a coverage start that pre-dates the LE occurred date. Open Manage Plans and Programs → your Program → Life Events, confirm Birth is attached with the right Enrollment Period (typically 30 days, coverage start = event date). Also re-run Evaluate Life Event Participation after the change — existing detected events won't auto-recompute eligibility.",
    answeredBy: 'Oracle Support — SR escalated',
  },
  {
    id: 'CC-7794',
    title: 'Imputed income for GTL over $50K showing $0 on payslip',
    body:
      'We configured imputed income for Group Term Life above $50K following the IRS Table I rates, but employees with $200K coverage are showing $0 imputed income on the payslip. The Variable Rate Profile is attached to the standard rate. Element entries are being created. Why would the calc result in zero?',
    status: 'open',
    source: 'My Oracle Support',
    posted: '2026-04-24',
    author: 'mpatel@globalcorp.example',
  },
  {
    id: 'CC-7768',
    title: 'Open Enrollment window not appearing in Benefits Self-Service',
    body:
      "Annual enrollment opens Monday and the window is not visible to employees in Me → Benefits. Scheduled Open process completed successfully (saw 12,400 detected). Eligibility profile looks fine. Plan year is correctly defined. Is there a cache or a flag I'm missing?",
    status: 'answered',
    seedCategory: 'open-enrollment',
    source: 'Customer Connect',
    posted: '2026-04-19',
    author: 'tlin@northwind.example',
    answer:
      "Two usual culprits: (1) the 'Display in Self-Service' flag on the Program is unchecked — toggle it on and re-run Open Life Event for affected workers; (2) the Self-Service display dates are set inside Manage Self-Service Configuration and are independent of the enrollment period — they often get missed. After fixing, run the Refresh Open Enrollment Window process for the impacted population.",
    answeredBy: 'Community MVP',
  },
  {
    id: 'CC-7755',
    title: 'Tobacco surcharge calculating before spouse is added as dependent',
    body:
      "Standard rate for tobacco surcharge applies $50/mo when the employee answers 'yes' to the tobacco user question. We need it to ALSO add $50 when a covered spouse is a tobacco user, but only if the spouse is actually enrolled in coverage. Right now it's adding the spouse surcharge even when only EE coverage is elected. Looking for the right Fast Formula approach.",
    status: 'open',
    source: 'Customer Connect',
    posted: '2026-04-23',
    author: 'rgomez@summitfoods.example',
  },
  {
    id: 'CC-7749',
    title: 'Vendor extract missing terminated employees with COBRA continuation',
    body:
      "Our weekly extract to Cigna is dropping employees the moment they're terminated, but COBRA enrollees need to continue appearing on the file with a status flag. Currently the change event doesn't fire for them. Is there a delivered extract definition or do we need a custom one?",
    status: 'answered',
    seedCategory: 'extracts',
    source: 'My Oracle Support',
    posted: '2026-04-15',
    author: 'kchen@meridianlogistics.example',
    answer:
      "The delivered Carrier Interface extract has a 'COBRA Participants' include flag on the Extract Definition — verify it's enabled. Then in the Change Event Definition for terminations, add a condition to exclude workers with active COBRA enrollments (filter on Person Benefit Balance with code 'COBRA_ACTIVE' = Y). The status flag on the outbound record is set via the Data Element formula — sample formula in MOS Doc ID 2641xxx.1.",
    answeredBy: 'Oracle Support',
  },
  {
    id: 'CC-7733',
    title: 'New dependent relationship type Domestic Partner not eligible for Medical',
    body:
      "Added Domestic Partner as a dependent relationship via Manage Dependent Coverage Eligibility Profiles. It shows up on the 'Add Dependent' form, but when an employee tries to enroll the DP in Medical, the dependent is greyed out. The DP eligibility profile is attached to the Medical option.",
    status: 'open',
    source: 'Customer Connect',
    posted: '2026-04-25',
    author: 'aok@harborhealth.example',
  },
  {
    id: 'CC-7720',
    title: '1095-C aggregate hours not summing across multiple assignments',
    body:
      'ACA hours of service report aggregates correctly for a single assignment, but employees with two concurrent active assignments only show hours from the primary. We need both. Standard configuration or do we need to extend the formula?',
    status: 'answered',
    seedCategory: 'aca',
    source: 'Customer Connect',
    posted: '2026-04-12',
    author: 'jsmith@unityhealth.example',
    answer:
      "Out of the box the ACA hours collection uses primary assignment only. Set the parameter 'Aggregate Hours Across Assignments' = Y on the ACA Hours Calculation flow. If you're on a release prior to 24C the parameter isn't exposed in the UI — you'll need to set it via the Hours Calculation formula override (sample in MOS Doc ID 2738xxx.1). Re-run hours for the measurement period after the change.",
    answeredBy: 'Oracle Support',
  },
  {
    id: 'CC-7705',
    title: 'BI Publisher report for benefits enrollment audit',
    body:
      "Need an audit-ready report listing every benefits election change in the last 90 days with: worker, plan, option, prior coverage, new coverage, life event reason, effective date, and updated by. I see PER_BEN_PRTT_ENRT_RSLT_F but the joins are killing me. Anyone have a sample data model?",
    status: 'open',
    source: 'Customer Connect',
    posted: '2026-04-25',
    author: 'dpark@cascadeenergy.example',
  },
  {
    id: 'CC-7691',
    title: 'COBRA notice not generating after voluntary termination',
    body:
      'Worker terminated voluntarily with end-of-month coverage end. The COBRA Qualifying Event was detected and the Notice was queued, but it never moved to Sent. Status sits at Pending. The COBRA notification process completed without errors. Where do I troubleshoot?',
    status: 'answered',
    seedCategory: 'cobra',
    source: 'My Oracle Support',
    posted: '2026-04-08',
    author: 'lthomas@bluewing.example',
    answer:
      "Pending status almost always means the Communication Type is missing a Delivery Method or the worker has no preferred contact. Check Manage Communication Types → COBRA Election Notice → Delivery (email AND print should both be defined as fallback). Then verify the worker's home email is populated and not flagged 'Do Not Contact'. Re-run the COBRA Notification process for that single person.",
    answeredBy: 'Community MVP',
  },
  {
    id: 'CC-7682',
    title: 'Eligibility profile excluding union employees by collective agreement',
    body:
      "Trying to build an Eligibility Profile that EXCLUDES union employees covered under CBA-IBEW-2024. Union and Collective Agreement criteria are both available, but when I add the union as 'Exclude' the profile evaluates to false for everyone — including non-union. Sequencing issue?",
    status: 'open',
    source: 'Customer Connect',
    posted: '2026-04-26',
    author: 'mhsu@coastalpower.example',
  },
];

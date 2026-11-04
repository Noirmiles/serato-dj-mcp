# Serato's terms and interoperability law: what this project may and may not do

serato-dj-mcp is not affiliated with Serato. This page records what we could find about Serato's
terms and about the law on interoperability, so that the project's limits (PRINCIPLES.md,
principle 6) rest on something written down.

**This is not legal advice; Myles must confirm before relying on it.**

Date accessed for every source below: **2026-11-04**. Nothing here has been reviewed by a lawyer.

## 1. Sources and what happened when we fetched them

| Source | URL | Result |
|---|---|---|
| Serato legal hub | https://serato.com/legal | Fetched. Mentions an "End User License Agreement (EULA)" but links to no EULA text. No "last updated" date. |
| Serato Terms of Use | https://serato.com/legal/terms-of-use | Fetched and read. No "last updated" date. |
| Serato Terms of Sale | https://serato.com/legal/terms-of-sale | Fetched and read. No "last updated" date. |
| Serato Software Legal Notices | https://serato.com/legal/software-legal-notices | Fetched. Third-party open-source licence notices, not Serato's EULA. Only the first ~39,000 characters were read verbatim; the page is far larger. |
| Serato EULA (guessed paths) | https://serato.com/legal/eula, https://serato.com/legal/software-eula, https://serato.com/dj/pro/eula, https://serato.com/dj/lite/eula, https://serato.com/eula, https://serato.com/legal/end-user-license-agreement | All HTTP 404. |
| Serato support search | https://support.serato.com/hc/en-us/search?query=EULA | HTTP 403; not read. |
| 17 U.S.C. § 1201 | https://www.law.cornell.edu/uscode/text/17/1201 | Fetched; subsection (f) quoted in section 4. |
| Directive 2009/24/EC | https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32009L0024 | Returned an empty body. **Article 6 text not obtained.** |
| NZ Copyright Act 1994, s 80A | https://www.legislation.govt.nz/act/public/1994/0143/latest/DLM345634.html | HTTP 403. **Text not obtained.** |
| Sega v. Accolade, 977 F.2d 1510 (9th Cir. 1992) | https://law.justia.com/cases/federal/appellate-courts/F2/977/1510/ | HTTP 403. **Not read.** |

Open third-party format documentation this project cites or may cite (not fetched for this page;
named so they can be checked): Holzhaus `serato-tags` (https://github.com/Holzhaus/serato-tags)
and `triseratops` (https://github.com/Holzhaus/triseratops).

## 2. What Serato's published terms say

### The EULA itself: not found

**We could not find the text of Serato's End User Licence Agreement on serato.com.** We looked at
the pages and URLs listed in section 1. Serato's own pages say the EULA is shown during
installation (Terms of Sale, clause 7.1, quoted below), so the text is probably only in the
installer. Someone needs to read it there (Serato DJ Lite / Pro installer) and add the clauses
here. Until then, **we do not know whether the EULA prohibits reverse engineering, decompiling or
interoperability analysis, and this page must not be read as saying it does or does not.**

### Clauses that do exist (quoted verbatim)

From the Terms of Sale, https://serato.com/legal/terms-of-sale (accessed 2026-11-04):

- Clause 7.1 (Software Licensing): "All **Serato Products** are licensed to you in accordance with the **Serato Terms** as well as the applicable **EULA**. You will be asked to agree to the terms of the applicable **EULA** at the time you install the **Serato Software**."
- Clause 7.2 (Software Licensing): "All rights, title and interest in respect of the intellectual property rights in the **Serato Software** remain with **Serato** and its applicable licensors at all times."
- Clause 13.2 (Governing Law): "Nothing in these **Terms of Sale**, including the choice of New Zealand law, affects your rights as a consumer to rely on such mandatory provisions of local law."

From the Terms of Use, https://serato.com/legal/terms-of-use (accessed 2026-11-04):

- Definition: "Serato Content means any content, excluding Third Party Content, that is hosted or stored on the **Serato Website** or a **Serato Product** including, but not limited to photographs, videos, text, images, sounds, music, computer code and software."
- Clause 2.3: "Unauthorised reproduction of any **Serato Content** is strictly forbidden. Reproduction of any **Serato Content** requires prior written consent from Serato. Please contact legal@serato.com for more information."
- Clause 2.4: "**Serato Content** cannot, under any circumstances, be redistributed or made available for download on any other website, server or file sharing mechanism."
- Clause 11 (Governing Law): "Nothing in these **Terms of Use**, including the choice of New Zealand law, affects your rights as a consumer to rely on such mandatory provisions of local law."

Neither the Terms of Use nor the Terms of Sale, as we read them, contains a clause using the words
reverse engineer, decompile, disassemble or interoperability. (The Software Legal Notices page
contains reverse-engineering wording only inside third-party licences such as the LGPL; those
govern the third-party libraries, not Serato's own code, and are not quoted here.)

What follows from these clauses, read conservatively: Serato's code and other content are
protected, copying them needs Serato's written consent, and a separate EULA we have not read
applies to the software.

## 3. What the law generally allows (summary, with the gaps stated)

- **United States.** 17 U.S.C. § 1201(f), quoted in section 4, lets a person who lawfully
  obtained a copy of a program circumvent an access control "for the sole purpose of identifying
  and analyzing those elements of the program that are necessary to achieve interoperability of an
  independently created computer program with other programs", only "to the extent any such acts
  of identification and analysis do not constitute infringement". It is a narrow exemption from
  the anti-circumvention rule, not a licence to copy. Separately, *Sega v. Accolade* (9th Cir.
  1992) is generally cited for the proposition that disassembly to reach functional requirements
  for compatibility can be fair use. We did not manage to read the case, so that description is
  from general knowledge, not from a source we checked. Courts have also in some cases enforced
  contract terms that forbid reverse engineering (a search result we saw cited *Bowers v. Baystate*,
  also not read).
- **European Union.** Directive 2009/24/EC, Article 6, is generally described as allowing
  decompilation without the rightholder's consent where that is indispensable to obtain the
  information needed for interoperability of an independently created program, subject to
  conditions (lawful user, information not otherwise readily available, limited to the parts
  necessary), and as not permitting use of the information for a competing expression of the
  program. Article 8 is generally described as making contrary contract terms void. **We could not
  fetch the text, so this is unverified and nothing is quoted.**
- **New Zealand.** Serato is a New Zealand company and its terms choose New Zealand law. Section
  80A of the Copyright Act 1994 is generally described as permitting a lawful user to decompile a
  program for interoperability under conditions, and the Act is generally described as limiting
  contracting out of such permitted acts. **We could not fetch the text, so this is unverified and
  nothing is quoted.** Which law applies to a given person also depends on where they are.

In every jurisdiction the permission, where it exists, is conditional and narrow, and covers
analysis aimed at interoperability, not copying code or assets. None of it was tested against our
facts.

## 4. 17 U.S.C. § 1201(f), verbatim

Source: https://www.law.cornell.edu/uscode/text/17/1201 (accessed 2026-11-04).

> (f) Reverse Engineering.—
>
> (1) Notwithstanding the provisions of subsection (a)(1)(A), a person who has lawfully obtained the right to use a copy of a computer program may circumvent a technological measure that effectively controls access to a particular portion of that program for the sole purpose of identifying and analyzing those elements of the program that are necessary to achieve interoperability of an independently created computer program with other programs, and that have not previously been readily available to the person engaging in the circumvention, to the extent any such acts of identification and analysis do not constitute infringement under this title.
>
> (2) Notwithstanding the provisions of subsections (a)(2) and (b), a person may develop and employ technological means to circumvent a technological measure, or to circumvent protection afforded by a technological measure, in order to enable the identification and analysis under paragraph (1), or for the purpose of enabling interoperability of an independently created computer program with other programs, if such means are necessary to achieve such interoperability, to the extent that doing so does not constitute infringement under this title.
>
> (3) The information acquired through the acts permitted under paragraph (1), and the means permitted under paragraph (2), may be made available to others if the person referred to in paragraph (1) or (2), as the case may be, provides such information or means solely for the purpose of enabling interoperability of an independently created computer program with other programs, and to the extent that doing so does not constitute infringement under this title or violate applicable law other than this section.
>
> (4) For purposes of this subsection, the term "interoperability" means the ability of computer programs to exchange information, and of such programs mutually to use the information which has been exchanged.

## 5. What this project may and may not do

Written conservatively. Because the EULA text is unread, the safe line is the one that would hold
even if the EULA forbids reverse engineering outright.

**Within the line (what the project does today):**

- Observe the files Serato writes into the user's own library folder, on the user's own machine
  and licence, and record what we saw (the method of docs/serato-4x-notes.md).
- Read on-disk formats: open `master.sqlite` and `root.sqlite` as SQLite databases and read their
  tables, from a snapshot copy.
- Black-box behaviour testing: make a change to a disposable or backed-up library, run Serato
  normally, and see what it does (for example, that it deletes nested or empty crates).
- Cite public third-party format documentation (Holzhaus `serato-tags`, `triseratops` and similar
  open projects) for formats they document, with attribution and in line with their licences.
  Using a format description is not the same as copying the code that implements it.
- Write only what principle 7 allows, with backup and verification, and say it is not affiliated.

**Outside the line (do not do these):**

- Decompile, disassemble or otherwise inspect the Serato binary or its libraries (for example
  with IDA, a decompiler or a tracer attached to the Serato process), even to answer a format
  question. If a question can only be answered that way, leave it unanswered and record it as
  unknown.
- Copy Serato code, strings, schemas dumped from inside the binary, or assets (icons, artwork,
  sounds, text) into the repository, documentation or fixtures. Fixtures are synthetic.
- Bypass or weaken any protection: licence checks, activation, encryption, or the "is Serato
  running" lock. The project's lock check exists to avoid writing while Serato is open, not to
  get around anything.
- Redistribute Serato software or content (Terms of Use 2.3 and 2.4).
- Use the project's own name or marks in a way that implies affiliation or endorsement.

## 6. Open items

1. Read the EULA in the Serato DJ installer and add the relevant clauses, verbatim, to section 2.
2. Obtain and quote Directive 2009/24/EC Article 6 and 8, and NZ Copyright Act 1994 s 80A, from
   their official sites, and read *Sega v. Accolade*; until then sections 3's EU, NZ and case
   descriptions are unverified.
3. Have Myles, ideally with a lawyer familiar with NZ and US law, confirm section 5.

**This is not legal advice; Myles must confirm before relying on it.**

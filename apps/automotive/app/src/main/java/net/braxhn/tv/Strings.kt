package net.braxhn.tv

import android.content.Context
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource

// Texter utanför Compose (felmeddelanden, modeller, nedladdningar) ur res/values*/strings.xml: engelska som standard,
// svenska i values-sv. I Compose används stringResource/pluralStringResource direkt. Följer enhetens språk.

object Strings {
    private lateinit var ctx: Context
    fun init(c: Context) { ctx = c.applicationContext }

    fun get(@StringRes id: Int, vararg args: Any): String = if (args.isEmpty()) ctx.getString(id) else ctx.getString(id, *args)
    fun plural(@PluralsRes id: Int, n: Int, vararg args: Any): String = ctx.resources.getQuantityString(id, n, *args)
}

/** En text ur strings.xml med platshållare (%1$s, %1$d …) */
fun str(@StringRes id: Int, vararg args: Any): String = Strings.get(id, *args)

/** En pluralform ur strings.xml; n väljer formen och fyller %1$d */
fun plural(@PluralsRes id: Int, n: Int): String = Strings.plural(id, n, n)

/** I Compose: stringResource med eller utan platshållare (kortare namn, och inga nya importrader i vyerna) */
@Composable
fun tr(@StringRes id: Int, vararg args: Any): String = if (args.isEmpty()) stringResource(id) else stringResource(id, *args)
